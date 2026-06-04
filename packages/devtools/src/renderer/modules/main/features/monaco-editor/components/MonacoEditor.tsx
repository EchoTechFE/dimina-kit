/**
 * The dimina code editor — Monaco mounted directly in the main renderer.
 *
 * Replaces the embedded OpenSumi editor (which ran in a separate
 * WebContentsView behind the `dmieditor://` protocol). This is a plain
 * React component that occupies the `editor` cell of the project window
 * layout — no overlay, no bounds-sync IPC.
 *
 * Responsibilities:
 *   - load the active project's file list (sandboxed `project:fs:*` IPC)
 *   - render a file tree + Monaco editor split
 *   - open a file on click (read → model), persist edits (debounced write)
 *   - wxml/wxss/js/json syntax + wxml completion/hover via `language/`
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileTree } from './FileTree'
import { onEditorOpenFile } from '@/shared/api'
import { useMonacoEditor } from '../hooks/useMonacoEditor'
import { languageForPath } from '../language/register'
import {
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  writeProjectFileSync,
} from '../services/file-service'
import { readWithRetry } from '../services/retry'

const SAVE_DEBOUNCE_MS = 500
/**
 * Cold-start retry budget for the auto-opened entry file, matching the
 * file-list load above. Rides out the brief window where the main
 * process's active project isn't registered yet (`ENOACTIVE`) and the
 * window where the Monaco instance hasn't finished mounting.
 */
const OPEN_RETRY_ATTEMPTS = 12
const OPEN_RETRY_DELAY_MS = 300
/** Files we try to open first when a project loads, in priority order. */
const PREFERRED_ENTRY_FILES = ['app.json', 'app.js', 'app.ts', 'app.wxss']

function joinPosix(root: string, rel: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return `${base}/${rel}`
}

interface MonacoEditorProps {
  /** Active project path (drives file-list reload). */
  projectPath: string
  /**
   * Whether the main process has finished registering the active project
   * (i.e. `openProject` resolved and `getProjectPath()` is non-empty).
   *
   * Gates the `project:fs:listFiles` load: opening a project clears the main
   * side's active path FIRST and only sets it once the compile completes, so
   * polling `listFiles` before then makes the fs sandbox throw `ENOACTIVE`
   * on every attempt — 12 transient rejections per open, each logged to the
   * renderer console and the main stdout. Waiting for `ready` (the same
   * `compileStatus === 'ready'` signal the simulator uses) skips that window
   * entirely without masking any genuine error: a real fs failure after the
   * project is registered still surfaces unchanged.
   *
   * Optional + defaults to `true` so callers/tests that don't thread a status
   * (the editor mounted in isolation) keep loading immediately.
   */
  ready?: boolean
}

/**
 * Observable save lifecycle for the auto-save indicator. Edits are persisted
 * automatically (debounced), so without a visible state the developer can't
 * tell whether their change is unsaved, in-flight, or written to disk — and a
 * silent write failure looks identical to a successful save. This is purely an
 * observation layer; it never gates or reorders the actual write.
 */
type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  idle: '',
  dirty: '编辑中…',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
}

const SAVE_STATUS_CLASS: Record<SaveStatus, string> = {
  idle: '',
  dirty: 'text-amber-600 dark:text-amber-400',
  saving: 'text-blue-600 dark:text-blue-400',
  saved: 'text-green-600 dark:text-green-400',
  error: 'text-red-600 dark:text-red-400',
}

export function MonacoEditor({ projectPath, ready = true }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [files, setFiles] = useState<string[]>([])
  const [root, setRoot] = useState('')
  const [activePath, setActivePath] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  // The currently-open file, read inside the debounced save closure.
  const activePathRef = useRef<string | null>(null)
  const rootRef = useRef('')
  const saveTimerRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<{ root: string; rel: string; value: string } | null>(null)
  const openSeqRef = useRef(0)

  // Apply a save-status update only if the file it describes is still the one
  // on screen. A flush triggered by switching files (or unmount) must never
  // stamp "已保存" over the freshly-opened file's status; same for a late
  // success/error landing after the user moved on. This keeps the indicator an
  // honest reflection of the *current* file without touching save timing.
  const setStatusFor = useCallback((rel: string, status: SaveStatus) => {
    if (activePathRef.current === rel) setSaveStatus(status)
  }, [])

  const flushPendingSave = useCallback(() => {
    const pending = pendingSaveRef.current
    if (!pending) return Promise.resolve()
    pendingSaveRef.current = null
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setStatusFor(pending.rel, 'saving')
    return writeProjectFile(joinPosix(pending.root, pending.rel), pending.value)
      .then(() => {
        setStatusFor(pending.rel, 'saved')
      })
      .catch((err) => {
        console.warn('[monaco] save failed:', err)
        setStatusFor(pending.rel, 'error')
      })
  }, [setStatusFor])

  // Synchronous twin of flushPendingSave for the window-unload path. A hard
  // window/app close tears the renderer down before an async write can land, so
  // the unload handler must BLOCK on the write — `writeProjectFileSync` round-
  // trips synchronously through the same sandbox and only returns once the bytes
  // are on disk. Shares pendingSaveRef/saveTimerRef with the async path so an
  // edit is never flushed twice. (The async flush still serves unmount / file
  // switch, where the renderer survives and a blocking write is unnecessary.)
  const flushPendingSaveSync = useCallback(() => {
    const pending = pendingSaveRef.current
    if (!pending) return
    pendingSaveRef.current = null
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setStatusFor(pending.rel, 'saving')
    try {
      const res = writeProjectFileSync(joinPosix(pending.root, pending.rel), pending.value)
      setStatusFor(pending.rel, res && res.ok ? 'saved' : 'error')
    } catch (err) {
      console.warn('[monaco] sync save on unload failed:', err)
      setStatusFor(pending.rel, 'error')
    }
  }, [setStatusFor])

  const handleChange = useCallback((value: string) => {
    const rel = activePathRef.current
    const r = rootRef.current
    if (!rel || !r) return
    pendingSaveRef.current = { root: r, rel, value }
    setStatusFor(rel, 'dirty')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const pending = pendingSaveRef.current
      if (!pending || pending.root !== r || pending.rel !== rel || pending.value !== value) return
      pendingSaveRef.current = null
      saveTimerRef.current = null
      setStatusFor(rel, 'saving')
      writeProjectFile(joinPosix(r, rel), value)
        .then(() => {
          setStatusFor(rel, 'saved')
        })
        .catch((err) => {
          console.warn('[monaco] save failed:', err)
          setStatusFor(rel, 'error')
        })
    }, SAVE_DEBOUNCE_MS)
  }, [setStatusFor])

  const editor = useMonacoEditor(containerRef, handleChange)

  const openFile = useCallback(
    async (rel: string, reveal?: { line?: number; column?: number }) => {
      const r = rootRef.current
      if (!r) return
      const seq = ++openSeqRef.current
      // Abandon the open as soon as another open is requested or the
      // project root changes underneath us (preserves openSeqRef cancel
      // semantics across the awaits below).
      const cancelled = () => seq !== openSeqRef.current || r !== rootRef.current
      const abs = joinPosix(r, rel)
      try {
        await flushPendingSave()
        if (cancelled()) return
        // Cold start: the main process may briefly report no active
        // project (ENOACTIVE) right after a project is opened. Retry the
        // read on transient errors only — a missing/forbidden file
        // (ENOENT/EACCES) still fails fast, so a manual click on such a
        // file doesn't stall. A normal read returns on the first attempt.
        const content = await readWithRetry(() => readProjectFile(abs), {
          attempts: OPEN_RETRY_ATTEMPTS,
          delayMs: OPEN_RETRY_DELAY_MS,
          isCancelled: cancelled,
        })
        if (cancelled() || content === undefined) return
        // The Monaco instance is created in a mount effect; on cold start
        // this open can win the race and find it not-yet-ready (openModel
        // would silently no-op, leaving the editor blank). Wait out that
        // window with the same bounded budget before attaching the model.
        for (let i = 0; i < OPEN_RETRY_ATTEMPTS && !editor.ready(); i++) {
          await new Promise((res) => setTimeout(res, OPEN_RETRY_DELAY_MS))
          if (cancelled()) return
        }
        if (cancelled() || !editor.ready()) return
        editor.openModel(abs, content, languageForPath(rel))
        activePathRef.current = rel
        setActivePath(rel)
        // Fresh file: clear any leftover indicator from the previous file
        // before the user starts editing this one.
        setSaveStatus('idle')
        // Jump to the requested position (e.g. a clicked console frame). Done
        // after openModel so the model is attached and line bounds are known.
        if (reveal && typeof reveal.line === 'number' && reveal.line > 0) {
          editor.revealPosition(reveal.line, reveal.column)
        }
      } catch (err) {
        console.warn('[monaco] open failed:', err)
      }
    },
    [editor, flushPendingSave],
  )

  // Load file list whenever the active project changes.
  useEffect(() => {
    let cancelled = false
    openSeqRef.current += 1
    activePathRef.current = null
    pendingSaveRef.current = null
    editor.clearModels()
    setActivePath(null)
    setSaveStatus('idle')
    ;(async () => {
      // The renderer already knows the active project path (the `projectPath`
      // prop), so use it directly as the root — don't round-trip through the
      // `project:fs:getRoot` IPC, which can briefly return '' while the main
      // process finishes registering a freshly-opened project. Retry listFiles
      // to ride out that same window (the fs sandbox throws ENOACTIVE — which
      // `listProjectFiles` swallows to `[]`/undefined — until the active
      // project is set).
      const r = projectPath
      rootRef.current = r
      setRoot(r)
      // Don't poll `listFiles` until the main process has actually registered
      // the active project. Opening a project clears the main side's path
      // first and sets it only after the compile finishes, so a load started
      // on the bare `projectPath` prop hammers the fs sandbox with ENOACTIVE
      // (12 transient rejections, all logged) for the whole compile window.
      // `ready` is that registration signal; gate on it instead of brute-
      // forcing through the error. Files stay `[]` (the correct empty initial
      // tree) until the project is open.
      if (!r || !ready) {
        setFiles([])
        return
      }
      let list: string[] = []
      for (let i = 0; i < 12 && !cancelled; i++) {
        list = (await listProjectFiles(r)) ?? []
        if (list.length > 0) break
        await new Promise((res) => setTimeout(res, 300))
      }
      if (cancelled) return
      setFiles(list)
    })()
    return () => {
      cancelled = true
      void flushPendingSave()
    }
  }, [projectPath, ready, editor, flushPendingSave])

  // Auto-open a sensible entry file once the list is available.
  useEffect(() => {
    if (!root || files.length === 0 || activePathRef.current) return
    const entry = PREFERRED_ENTRY_FILES.find((f) => files.includes(f)) ?? files[0]
    if (entry) void openFile(entry)
  }, [root, files, openFile])

  // Open a file at a position on request from the main process — the "click a
  // console file link → open in editor" pipeline. Main maps the clicked
  // DevTools resource URL to a project-relative path (the same key `openFile`
  // uses) and broadcasts it here; `openFile` reads + attaches the model and
  // `revealPosition` jumps to the logged frame. A path outside the active
  // project (no such file) just fails the read and no-ops, same as a manual
  // click on a missing file.
  useEffect(() => {
    return onEditorOpenFile((payload) => {
      if (!payload || typeof payload.path !== 'string' || payload.path === '') return
      void openFile(payload.path, { line: payload.line, column: payload.column })
    })
  }, [openFile])

  // Flush a pending edit when the window is about to unload (devtools window
  // closing / reload / app quit). The projectPath-effect cleanup flushes on a
  // real React unmount, but a window unload tears the page down WITHOUT
  // unmounting, so the last in-debounce-window edit would otherwise be dropped.
  //
  // This path uses the SYNCHRONOUS flush: a hard close races the renderer's
  // teardown against an async write, and the async write loses. The sync write
  // blocks teardown until the bytes are on disk, closing that loss window.
  // (Project close/switch — the common case — still goes through the async
  // unmount flush above, where the renderer survives and the main side accepts
  // the write against the just-closed root via project-fs `pickWriteRoot`.)
  useEffect(() => {
    const onBeforeUnload = () => {
      flushPendingSaveSync()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushPendingSaveSync])

  // Project display name = the root directory's basename; full path on hover.
  const projectName = root ? (root.split('/').filter(Boolean).pop() ?? root) : ''

  return (
    <div className="flex h-full w-full overflow-hidden" data-area="editor">
      <div className="h-full w-56 shrink-0 border-r border-black/10 dark:border-white/10 flex flex-col overflow-hidden">
        <div
          className="shrink-0 px-2 py-1.5 text-xs font-medium border-b border-black/10 dark:border-white/10 flex items-center gap-2"
          title={root || undefined}
        >
          <span className="truncate opacity-80">{projectName || '未打开项目'}</span>
          {activePath && saveStatus !== 'idle' && (
            <span
              className={`shrink-0 ml-auto font-normal ${SAVE_STATUS_CLASS[saveStatus]}`}
              data-testid="save-status"
            >
              {SAVE_STATUS_LABEL[saveStatus]}
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileTree files={files} activePath={activePath} onOpen={openFile} />
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-w-0 h-full" />
    </div>
  )
}
