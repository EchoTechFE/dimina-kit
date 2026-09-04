import path from 'path'
import type { BrowserWindow } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import type { AppServices } from '../services/app-services.js'
import type { WindowContextRouter } from '../services/window-contexts/context-router.js'
import { createInternalDevtoolsWindow } from '../windows/internal-devtools-window/index.js'
import { wireMainWindowEvents } from '../windows/main-window/index.js'
import { isAppQuitting } from './lifecycle.js'
import { installGlobalMirrors } from './global-mirrors.js'
import { setupEditorView } from './editor-view.js'
import { createActiveAppIdResolver, setupWindowRuntimeServices } from './window-runtime-services.js'
import { createWorkbenchWindow, type ProjectRef, type ProjectWindow } from './project-window.js'

/**
 * The window context type, taken from `ProjectWindow` so this module doesn't
 * import `WorkbenchContext` directly (see eslint-workbench-context-gate).
 */
type WindowContext = ProjectWindow['context']

export interface WorkbenchWindowDeps {
  config: WorkbenchAppConfig
  rendererDir: string
  appServices: AppServices
  router: WindowContextRouter<WindowContext>
  /**
   * Per-window module wiring — the `setupWindow` half of the built-in modules
   * (notably the simulator's `installBridgeRouter`, which assigns `ctx.bridge`
   * / `ctx.consoleForwarder` / `ctx.diagnostics`). The IPC half is registered
   * once against the router and is NOT repeated here.
   */
  setupWindowModules: (ctx: WindowContext) => void
  /**
   * Told whenever `activeContext()` can have changed — a window opened, took
   * focus, or was torn down. App-level services that hold something aimed at
   * the active project window (the MCP CDP connections) re-aim on it.
   */
  onActiveContextChanged?: () => void
  /**
   * Host hook, awaited before a window tears its project down, and told which
   * project that is. A rejection is logged and swallowed: the hook runs on the
   * way out, so it can react but never cancel the teardown behind it.
   */
  onBeforeClose?: (win: ProjectWindow, project: ProjectRef) => Promise<void> | void
  /**
   * Host hook, awaited once the window is fully wired and before `open()`
   * reports success, and told which project it belongs to. Unlike
   * `onBeforeClose` it CAN fail the open: there is no usable window to react
   * in yet, so a rejection tears the half-built window down and travels back
   * to the caller unchanged.
   */
  setupProjectWindow?: (win: ProjectWindow, project: ProjectRef) => Promise<void> | void
  /**
   * Gate every open waits on before it builds anything. The app registers the
   * open-project IPC before it awaits the host's own setup hook, so a renderer
   * that races ahead must be parked rather than handed a window the host has
   * not finished extending. Omitted means there is nothing to wait for.
   */
  ready?: Promise<void>
}

export interface WorkbenchWindowManager {
  /**
   * Open `project` in its own window, or focus the window already showing it.
   * Resolves once the window exists and its per-window services are wired.
   * Opens and closes of the same project are serialized, so a call arriving
   * while that project's window is still closing waits it out and then opens a
   * fresh window — never a second one alongside it. Rejects if the window
   * cannot be brought up, leaving nothing behind.
   */
  open: (project: ProjectRef) => Promise<BrowserWindow>
  list: () => ProjectWindow[]
  /**
   * The workbench context the user is working in — the focused one, or the
   * most recently opened when focus sits on the project list. Null until the
   * first project window opens.
   */
  activeContext: () => WindowContext | null
  /**
   * Tear every workbench window down (app quit / runtime disposal). Terminal
   * and idempotent: once it starts, no `open()` — pending, queued or already
   * in flight — leaves a live window behind, and it does not resolve until
   * every in-flight open or close has settled.
   */
  disposeAll: () => Promise<void>
}

/**
 * Close semantics for a workbench window. Unlike the old single-window app —
 * where closing meant "return this window to the project list" — closing a
 * workbench window means the window itself goes away, so teardown must finish
 * BEFORE the window is destroyed.
 *
 * Three guards, each covering a failure this app has actually shipped:
 *
 * 1. A real application quit (⌘Q / menu Quit / app.quit()) fires `before-quit`
 *    first. Let it through: converting a quit into a project close swallows the
 *    quit and the app can never exit with a project open.
 * 2. A close arriving while teardown is already in flight (the user
 *    rapid-double-clicked) MUST keep the window. This runs BEFORE any
 *    session check on purpose: `closeProject()` → `disposeSession()`
 *    synchronously nulls the active session before it finishes awaiting
 *    `session.close()`, so a session-presence check would already read false
 *    by the time the second close arrives, fall through with no
 *    `preventDefault()`, and let Chromium destroy the window out from under a
 *    live teardown.
 * 3. Teardown is UNCONDITIONAL — deliberately not gated on
 *    `hasActiveSession()`. A failed open (invalid/non-existent project) never
 *    creates a session, yet the window still owns views, an editor server and
 *    IPC registrations. Gating on session presence let that case skip teardown
 *    entirely, which is how closing an invalid project used to take the whole
 *    app down with it.
 */
function wireWorkbenchWindowEvents(
  win: BrowserWindow,
  ctx: WindowContext,
  teardown: () => Promise<void>,
): Disposable {
  let closing = false
  let torndown = false
  return wireMainWindowEvents(win, {
    context: ctx,
    onResize: () => ctx.views.repositionAll(),
    onClose: async (e) => {
      if (isAppQuitting()) return
      if (closing) {
        e.preventDefault()
        return
      }
      // Safety net for a `close()` that arrives after teardown finished (this
      // module destroys the window itself, which emits no `close`).
      if (torndown) return

      e.preventDefault()
      closing = true
      try {
        await teardown()
      } catch (err) {
        console.error('[workbench] workbench window teardown failed:', err)
      } finally {
        closing = false
        torndown = true
      }
      if (!win.isDestroyed()) win.destroy()
    },
  })
}

export function createWorkbenchWindowManager(
  deps: WorkbenchWindowDeps,
): WorkbenchWindowManager {
  const { config, rendererDir, appServices, router } = deps
  // Keyed by project path: one window per project, so a second open of the
  // same project focuses the existing window instead of racing two sessions
  // (and two compile workers) over the same directory.
  const windows = new Map<string, ProjectWindow>()
  // Serializes every open and close of one project path. The map alone cannot
  // carry "one window per project": an open has awaits in it, and a close
  // awaits host code, so overlapping requests (a re-click on the project list,
  // MCP's project_open) must queue rather than each find "no window" and build
  // one. Entries are dropped once a path goes idle.
  const pathQueues = new Map<string, Promise<unknown>>()
  // Terminal state owned by this manager, deliberately not `isAppQuitting()`:
  // a runtime can be disposed while the app keeps running, and a manager that
  // has torn everything down must never build another window either way.
  let disposed = false

  function disposedError(): Error {
    return new Error('workbench window manager is disposed')
  }

  function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = pathQueues.get(path) ?? Promise.resolve()
    // Same task on either outcome: a failed open or close must not wedge the
    // queue for its path.
    const result = previous.then(task, task)
    const settled = result.then(() => {}, () => {})
    pathQueues.set(path, settled)
    void settled.then(() => {
      if (pathQueues.get(path) === settled) pathQueues.delete(path)
    })
    return result
  }

  async function openWindow(project: ProjectRef): Promise<BrowserWindow> {
    // Checked where the queued task starts running, not where it was queued:
    // an open sitting behind a close on the same path can be dequeued long
    // after `disposeAll()` began, and must fail instead of resurrecting a
    // project the app just tore down.
    if (disposed) throw disposedError()

    const existing = windows.get(project.path)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      router.setActive(existing.context)
      deps.onActiveContextChanged?.()
      return existing.window
    }

    const projectWindow = createWorkbenchWindow(
      { config, rendererDir, appServices, router },
      project,
    )
    const { window, context } = projectWindow
    windows.set(project.path, projectWindow)

    const teardown = async () => {
      try {
        await deps.onBeforeClose?.(projectWindow, project)
      } catch (err) {
        // The hook is the host's chance to react, not a veto: everything below
        // (compile session, bridge router, editor server, IPC and app-level
        // listeners) has to go, and the map entry with it, or the window's
        // resources outlive a window nothing can reach any more.
        console.error('[workbench] host onBeforeClose hook failed:', err)
      }
      try {
        await projectWindow.dispose()
      } finally {
        // Dropped LAST: while teardown is in flight this project still has a
        // window, and an open arriving mid-close must queue behind it (see
        // `enqueue`) instead of finding an empty map and building a second one.
        if (windows.get(project.path) === projectWindow) windows.delete(project.path)
      }
      // After the map entry is gone, so listeners read the window that is left.
      deps.onActiveContextChanged?.()
    }

    try {
      // The standalone internal DevTools window debugs THIS window's renderer,
      // so it is per-window wiring. `isAppQuitting` lets the controller stop
      // intercepting 'close' during a real quit.
      context.internalDevtoolsWindow = createInternalDevtoolsWindow(window, { isAppQuitting })
      context.registry.add(toDisposable(() => context.internalDevtoolsWindow?.dispose()))

      // Wired before the awaited steps below: the window is already on screen
      // and closable, so it must never exist without the close handling that
      // disposes it.
      context.registry.add(wireWorkbenchWindowEvents(window, context, () =>
        enqueue(project.path, teardown)))

      // Whichever workbench window the user is looking at answers the IPC that
      // no single window owns (menus, app-level host windows).
      const onFocus = () => {
        router.setActive(context)
        deps.onActiveContextChanged?.()
      }
      window.on('focus', onFocus)
      context.registry.add(toDisposable(() => {
        if (!window.isDestroyed()) window.removeListener('focus', onFocus)
      }))

      // Order matters: the bridge router assigns ctx.bridge / ctx.consoleForwarder
      // / ctx.diagnostics, which both the mirrors and the runtime services read.
      deps.setupWindowModules(context)
      installGlobalMirrors(context, window)

      const getActiveAppId = createActiveAppIdResolver(context)
      setupWindowRuntimeServices(context, window, getActiveAppId, project.path)
      await setupEditorView(config, context, getActiveAppId)
      // `disposeAll()` can land while this open is parked above. It waits for
      // this task to settle rather than reaching into a half-built window, so
      // the undo below is this open's own job.
      if (disposed) throw disposedError()
      // Last, so the host configures a window whose own services are all up.
      // It runs while the window is already in `windows`: a hook that opens
      // views or drives the session needs the window reachable, and a failure
      // path below removes the entry again.
      await deps.setupProjectWindow?.(projectWindow, project)
    } catch (err) {
      // A half-built window (the editor's http server can fail to bind) leaves
      // live services behind and keeps the project counted as open — which is
      // what the list window reads to decide whether to stay hidden. Undo the
      // whole thing before handing the failure back.
      windows.delete(project.path)
      await projectWindow.dispose().catch((disposeErr) => {
        console.warn('[workbench] failed to dispose a partially opened window:', disposeErr)
      })
      if (!window.isDestroyed()) window.destroy()
      throw err
    }

    deps.onActiveContextChanged?.()
    return window
  }

  return {
    // One project window per RESOLVED absolute path: two differently-spelled
    // strings pointing at the same directory ('/a/b' vs '/a/b/.') must not
    // race two windows (and two compile workers) over one project. Resolving
    // here, before the path reaches `windows`/`pathQueues`/`openWindow`,
    // keeps every downstream lookup keyed on the one canonical spelling.
    open: (project) => {
      const normalized: ProjectRef = { ...project, path: path.resolve(project.path) }
      // The readiness gate is awaited inside the queued task, not before
      // queuing: opens of one path must keep their arrival order, and a
      // `disposeAll()` landing meanwhile still finds this open in the queue it
      // drains rather than floating loose outside it.
      return enqueue(normalized.path, async () => {
        await deps.ready
        return openWindow(normalized)
      })
    },
    list: () => [...windows.values()],
    activeContext: () => {
      const active = router.active()
      const all = [...windows.values()]
      if (all.some((pw) => pw.context === active)) return active
      return all.length > 0 ? all[all.length - 1]!.context : null
    },
    disposeAll: async () => {
      // Set before waiting, never after: the in-flight opens and closes being
      // waited on are exactly the code that has to observe the terminal state
      // in order to finish instead of building on.
      disposed = true
      // Drained repeatedly because settling one entry releases whatever was
      // queued behind it on the same path; new opens reject at their task
      // start, so the queues run dry.
      while (pathQueues.size > 0) {
        await Promise.allSettled([...pathQueues.values()])
      }

      // Snapshotted only now: an open that lost the race above already removed
      // and disposed itself, and a finished close already dropped its entry,
      // so nothing here is disposed twice.
      const all = [...windows.values()]
      windows.clear()
      // Serial: each teardown closes a devkit session and an http server, and
      // a parallel storm during quit is exactly when those races bite.
      for (const projectWindow of all) {
        await projectWindow.dispose().catch((err) => {
          console.warn('[workbench] failed to tear down workbench window:', err)
        })
        if (!projectWindow.window.isDestroyed()) projectWindow.window.destroy()
      }
    },
  }
}
