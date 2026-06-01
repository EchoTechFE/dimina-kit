/**
 * Teardown / beforeunload data-loss tests for <MonacoEditor/>.
 *
 * REGRESSION GUARDED: an edit that is still inside the 500ms debounce window
 * (`pendingSaveRef` set, `saveTimerRef` pending) is silently DROPPED when the
 * editor goes away before the timer fires — i.e. the developer closes the
 * project / the window unloads in the half-second after their last keystroke,
 * and their last edit never reaches disk.
 *
 * Two teardown paths flush the pending edit, but they flush DIFFERENTLY because
 * the renderer's survival differs:
 *
 *   - Case A (renderer SURVIVES — project close/switch): a React unmount before
 *     the debounce timer fires must flush via the ASYNC `writeProjectFile`,
 *     with the latest content of the open file. The renderer stays alive, so
 *     the in-flight async IPC is guaranteed to land — no synchronous blocking
 *     is needed, and this path is unchanged.
 *   - Case B (renderer is TORN DOWN — hard window/app close): a `beforeunload`
 *     fired while an edit is pending must flush via the SYNCHRONOUS
 *     `writeProjectFileSync`, NOT the async `writeProjectFile`. On a hard
 *     window/app close the async IPC may never land before the page is torn
 *     down, dropping the edit; a synchronous, blocking sync-IPC write provably
 *     completes (bytes persisted) before teardown proceeds. The async writer
 *     must NOT be invoked by the beforeunload handler.
 *
 * Everything below the component is mocked: the sandboxed file-service IPC
 * wrappers (async `writeProjectFile` + the new synchronous `writeProjectFileSync`)
 * and the Monaco controller hook (so no real Monaco / IPC / language
 * registration runs under jsdom). The `useMonacoEditor` mock returns a STABLE
 * controller object — exactly like the real hook's `controllerRef.current` —
 * so the component's effects don't re-run on every render (a non-stable
 * controller would make the file-list effect re-run and flush spuriously,
 * masking the very gap under test). The mock also hands the test the
 * `onChange` callback the component wires up, so the test can drive a content
 * change the way real typing would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

// ── file-service: capture writes; resolve reads/list so a file auto-opens ──
const writeProjectFile = vi.fn<(abs: string, content: string) => Promise<void>>(
  () => Promise.resolve(),
)
// New synchronous, blocking writer used on hard window/app close (beforeunload).
// A jsdom sync mock is trivial — it just returns the success shape immediately.
const writeProjectFileSync = vi.fn<
  (abs: string, content: string) => { ok: boolean; code?: string; message?: string }
>(() => ({ ok: true }))
const readProjectFile = vi.fn<(abs: string) => Promise<string>>(() =>
  Promise.resolve('initial-content'),
)
const listProjectFiles = vi.fn<(root: string) => Promise<string[]>>(() =>
  Promise.resolve(['app.json']),
)

vi.mock('../services/file-service', () => ({
  writeProjectFile: (abs: string, content: string) => writeProjectFile(abs, content),
  writeProjectFileSync: (abs: string, content: string) =>
    writeProjectFileSync(abs, content),
  readProjectFile: (abs: string) => readProjectFile(abs),
  listProjectFiles: (root: string) => listProjectFiles(root),
  getProjectRoot: () => Promise.resolve(''),
}))

// Avoid pulling real Monaco language registration into jsdom.
vi.mock('../language/register', () => ({
  ensureDiminaLanguages: () => {},
  languageForPath: () => 'json',
}))

// ── useMonacoEditor: a controllable, always-ready, STABLE stub controller. ──
// The captured `onChange` lets the test simulate the user editing the open
// file. `openModel` records the value so `getValue()` mirrors what the
// component last attached. The controller object identity is stable across
// renders (memoised in module scope) to match the real hook's `controllerRef`.
let capturedOnChange: ((value: string) => void) | undefined
let currentValue = ''

const stableController = {
  openModel: (_key: string, value: string) => {
    currentValue = value
  },
  clearModels: () => {},
  getValue: () => currentValue,
  setTheme: () => {},
  // Always ready so the open path attaches the model on the first tick.
  ready: () => true,
}

vi.mock('../hooks/useMonacoEditor', () => ({
  useMonacoEditor: (
    _containerRef: unknown,
    onChange?: (value: string) => void,
  ) => {
    capturedOnChange = onChange
    return stableController
  },
}))

import { MonacoEditor } from './MonacoEditor'

/**
 * Render the editor under real timers, wait for the entry-file auto-open to
 * attach a model (at which point `activePathRef`/`rootRef` are set and
 * `onChange` is live), then freeze time so the 500ms debounce can't fire on
 * its own. Returns the testing-library render result.
 */
async function renderOpened(): Promise<ReturnType<typeof render>> {
  // Real timers while the async open settles (waitFor needs the macrotask
  // queue to advance); the debounce window is frozen by the caller afterwards.
  vi.useRealTimers()
  const result = render(<MonacoEditor projectPath="/proj" />)
  await waitFor(() => {
    expect(readProjectFile).toHaveBeenCalled()
    expect(capturedOnChange).toBeTypeOf('function')
  })
  // Let any trailing open microtasks settle so a later state update doesn't
  // re-enter the open path.
  await act(async () => {
    await Promise.resolve()
  })
  vi.useFakeTimers()
  return result
}

beforeEach(() => {
  writeProjectFile.mockClear()
  writeProjectFileSync.mockClear()
  readProjectFile.mockClear()
  listProjectFiles.mockClear()
  capturedOnChange = undefined
  currentValue = ''
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('MonacoEditor — flushes pending edits on teardown (data-loss guard)', () => {
  // Case A is UNCHANGED: the renderer survives a project close/switch, so the
  // unmount-cleanup flush uses the ASYNC `writeProjectFile` (the in-flight IPC
  // is guaranteed to land in a surviving renderer). The only test-side change
  // is asserting the synchronous writer is NOT used on this path.
  it('Case A: unmounting before the debounce timer fires still writes the latest edit (ASYNC)', async () => {
    const { unmount } = await renderOpened()

    // Simulate a keystroke: arms the 500ms debounce + sets pendingSaveRef.
    act(() => {
      capturedOnChange!('EDITED-BEFORE-UNMOUNT')
    })

    // Pre-condition: the debounce has NOT yet written (still within 500ms).
    expect(writeProjectFile).not.toHaveBeenCalled()

    // Tear the component down *before* the timer fires.
    act(() => {
      unmount()
    })

    // The pending edit must have been flushed to disk on teardown — otherwise
    // the developer's last half-second of edits vanishes on project close.
    // The renderer survives this path, so the flush is the ASYNC writer.
    expect(writeProjectFile).toHaveBeenCalledTimes(1)
    const [, content] = writeProjectFile.mock.calls[0]!
    expect(content).toBe('EDITED-BEFORE-UNMOUNT')
    // The synchronous writer is reserved for the hard-close (beforeunload)
    // path; the unmount path must not reach for it.
    expect(writeProjectFileSync).not.toHaveBeenCalled()
  })

  // Case B is REWRITTEN to the new contract: on a hard window/app close the
  // async IPC may never land before teardown, so the beforeunload handler must
  // flush via the SYNCHRONOUS, BLOCKING `writeProjectFileSync` — and must NOT
  // use the async `writeProjectFile`, which previously serviced this path.
  it('Case B: a beforeunload while an edit is pending flushes the latest edit SYNCHRONOUSLY', async () => {
    await renderOpened()

    act(() => {
      capturedOnChange!('EDITED-BEFORE-UNLOAD')
    })

    // Pre-condition: nothing has been written yet (still within 500ms), via
    // either writer.
    expect(writeProjectFile).not.toHaveBeenCalled()
    expect(writeProjectFileSync).not.toHaveBeenCalled()

    // The window is about to unload (devtools window closing / reload) with an
    // unsaved edit still inside the debounce window. The page is being torn
    // down, so the flush must be synchronous to provably persist before exit.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })

    // Exactly one synchronous write, to the open file's absolute path, with the
    // LATEST pending content.
    expect(writeProjectFileSync).toHaveBeenCalledTimes(1)
    const [abs, content] = writeProjectFileSync.mock.calls[0]!
    expect(abs).toBe('/proj/app.json')
    expect(content).toBe('EDITED-BEFORE-UNLOAD')

    // The async writer must NOT be used on the hard-close path — it might not
    // land before teardown, which is the bug this contract fixes.
    expect(writeProjectFile).not.toHaveBeenCalled()
  })

  // No pending edit → beforeunload is a no-op for the writer.
  it('a beforeunload with no pending edit does not write synchronously', async () => {
    await renderOpened()

    // No `onChange` fired → `pendingSaveRef` is empty.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })

    expect(writeProjectFileSync).not.toHaveBeenCalled()
    expect(writeProjectFile).not.toHaveBeenCalled()
  })
})
