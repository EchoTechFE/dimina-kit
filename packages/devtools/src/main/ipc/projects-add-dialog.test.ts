/**
 * Behavior tests for the `projects:add` IPC handler.
 *
 * Contract under test:
 *  - Valid + new directory: handler returns a Project, no dialog is shown.
 *  - Valid + already-imported directory: handler returns the EXISTING Project
 *    (same `.path`), `dialog.showMessageBox` is called once with `type: 'info'`
 *    and the Chinese title '项目已存在'; the persisted list does not grow.
 *  - Invalid directory: handler throws and `dialog.showMessageBox` is called
 *    with `type: 'error'` and title '无法导入项目'.
 *
 * The tests operate purely against the IPC handler — no renderer involvement.
 * Electron and the `fs` module are stubbed so persistence is in-memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted stub state ──────────────────────────────────────────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  /** Active ipcMain.handle channels (channel name → handler fn). */
  const handlers = new Map<string, AnyFn>()
  /** Every channel ever registered via ipcMain.handle. */
  const handleCalls: string[] = []
  const removeHandlerCalls: string[] = []
  const onCalls: string[] = []
  const removeListenerCalls: string[] = []

  /**
   * In-memory file system slice the projects repository touches:
   *  - `/.../dimina-projects.json` for the persisted project list.
   *  - `<projectDir>/app.json` for `validateProjectDir`.
   *
   * We control these explicitly so tests don't depend on the real fs layout.
   */
  const projectsJsonPath = '/tmp/dimina-test-userdata/dimina-projects.json'
  let projectsJsonContent: string | null = null
  /** Set of project directories whose `app.json` should report as existing. */
  const projectsWithAppJson = new Set<string>()

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...args: unknown[]) => {
          listeners[event]?.delete(wrap)
          return fn(...args)
        }
        ;(listeners[event] ??= new Set()).add(wrap)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
    }
  }

  function reset() {
    handlers.clear()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    onCalls.length = 0
    removeListenerCalls.length = 0
    projectsJsonContent = null
    projectsWithAppJson.clear()
  }

  return {
    handlers,
    handleCalls,
    removeHandlerCalls,
    onCalls,
    removeListenerCalls,
    projectsJsonPath,
    get projectsJsonContent() {
      return projectsJsonContent
    },
    set projectsJsonContent(v: string | null) {
      projectsJsonContent = v
    },
    setProjectsJson(v: string | null) {
      projectsJsonContent = v
    },
    getProjectsJson() {
      return projectsJsonContent
    },
    projectsWithAppJson,
    makeEmitter,
    reset,
  }
})

// ── electron stub ────────────────────────────────────────────────────────
vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, fn: AnyFn) => {
      if (stubs.handlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        )
      }
      stubs.handlers.set(channel, fn)
      stubs.handleCalls.push(channel)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.handlers.delete(channel)
      stubs.removeHandlerCalls.push(channel)
    }),
    on: vi.fn((event: string, fn: AnyFn) => {
      stubs.onCalls.push(event)
      ipcEmitter.on(event, fn)
    }),
    removeListener: vi.fn((event: string, fn: AnyFn) => {
      stubs.removeListenerCalls.push(event)
      ipcEmitter.removeListener(event, fn)
    }),
  }

  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    quit: vi.fn(),
    commandLine: {
      getSwitchValue: vi.fn(() => ''),
      appendSwitch: vi.fn(),
    },
  }

  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = Math.floor(Math.random() * 1e6)
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    send = vi.fn()
    isDestroyed = () => this.destroyed
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    setDevToolsWebContents = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    executeJavaScript = vi.fn(() => Promise.resolve(undefined))
    reload = vi.fn()
    getType = () => 'window'
    getURL = () => ''
    debugger = {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve({ entries: [] })),
    }
    close = vi.fn(() => {
      this.destroyed = true
    })
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class View {
    children: View[] = []
    addChildView(child: View) {
      this.children.push(child)
    }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
  }

  class BrowserWindow {
    private em = stubs.makeEmitter()
    destroyed = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    getContentSize = () => [1280, 980]
    setIcon = vi.fn()
    setTitle = vi.fn()
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    close = vi.fn()
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    static getAllWindows = vi.fn(() => [] as BrowserWindow[])
  }

  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
      registerPreloadScript: vi.fn(),
    })),
  }

  const dialog = {
    showOpenDialog: vi.fn(() =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    ),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  }

  const Menu = {
    buildFromTemplate: vi.fn((tpl: unknown) => ({ template: tpl })),
    setApplicationMenu: vi.fn(),
  }

  const shell = {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
  }

  const nativeImage = {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  }

  const nativeTheme = { themeSource: 'system' }

  const globalShortcut = {
    register: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }

  const webContentsStatic = {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => [] as WebContents[]),
  }

  const Tray = vi.fn()

  return {
    app,
    ipcMain,
    BrowserWindow,
    WebContentsView,
    BrowserView: WebContentsView,
    View,
    webContents: webContentsStatic,
    session: sessionStub,
    dialog,
    Menu,
    shell,
    nativeImage,
    nativeTheme,
    globalShortcut,
    Tray,
    default: {},
  }
})

// fs — controlled in-memory layer for projects-json + per-project app.json
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')

  function existsSync(p: import('fs').PathLike): boolean {
    const s = String(p)
    if (s === stubs.projectsJsonPath) {
      return stubs.getProjectsJson() !== null
    }
    if (s.endsWith('/app.json') || s.endsWith('\\app.json')) {
      const dir = s.replace(/[\\/]app\.json$/, '')
      return stubs.projectsWithAppJson.has(dir)
    }
    // userData dir, etc.
    return true
  }

  function readFileSync(p: import('fs').PathOrFileDescriptor, opts?: unknown): string {
    const s = String(p)
    if (s === stubs.projectsJsonPath) {
      const content = stubs.getProjectsJson()
      if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    }
    return (real.readFileSync as (...a: unknown[]) => string)(p as never, opts as never)
  }

  function writeFileSync(p: import('fs').PathOrFileDescriptor, data: string | Buffer | Uint8Array): void {
    const s = String(p)
    if (s === stubs.projectsJsonPath) {
      stubs.setProjectsJson(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
      return
    }
    // Swallow other writes silently — tests don't care.
  }

  function mkdirSync(): void {
    // no-op
  }

  function statSync(_p: import('fs').PathLike): import('fs').Stats {
    // Pretend project dirs are directories so any size/mtime probing succeeds.
    return {
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
      mtimeMs: 0,
    } as unknown as import('fs').Stats
  }

  const mocked = {
    ...real,
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    statSync,
    watch: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  }
  return {
    ...mocked,
    default: mocked,
  }
})

vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() =>
    Promise.resolve({ port: 0, appInfo: {}, close: () => Promise.resolve() }),
  ),
}))

// ── Lazy imports (after vi.mock('electron') is set up) ──────────────────
import { ProjectsChannel } from '../../shared/ipc-channels.js'
let createWorkbenchApp: typeof import('../app/app.js').createWorkbenchApp

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('../app/app.js'))
})

/**
 * Invoke a registered IPC handler the same way ipcMain.handle would. The
 * event's `sender` is the main window's webContents so it passes the
 * workbench sender-policy (isMainSender).
 */
async function invokeHandler(
  mainWebContents: { id: number; isDestroyed: () => boolean; getURL?: () => string },
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = stubs.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for '${channel}'`)
  const fakeEvent = { sender: mainWebContents }
  return await (fn as (event: unknown, ...a: unknown[]) => unknown)(fakeEvent, ...args)
}

describe('projects:add — duplicate detection dialog', () => {
  it('valid + new directory returns a Project and does not call showMessageBox', async () => {
    const dir = '/tmp/projA'
    stubs.projectsWithAppJson.add(dir) // make validateProjectDir pass
    stubs.setProjectsJson(JSON.stringify([])) // empty list

    const instance = await createWorkbenchApp({}).setup()
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    const result = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string }

    expect(result).toBeDefined()
    expect(result.path).toBe(dir)
    expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()

    // List grew to 1.
    const persisted = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(persisted.filter((p) => p.path === dir)).toHaveLength(1)

    await instance.dispose()
  })

  it('valid + already-imported directory shows an info dialog with title 项目已存在 and does NOT add a duplicate entry', async () => {
    const dir = '/tmp/projDup'
    stubs.projectsWithAppJson.add(dir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createWorkbenchApp({}).setup()
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    // First import — succeeds silently.
    const first = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string }
    expect(first.path).toBe(dir)
    expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()

    const listAfterFirst = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(listAfterFirst.filter((p) => p.path === dir)).toHaveLength(1)

    // Second import — same path. Should surface info dialog and NOT throw.
    const second = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string }

    expect(second).toBeDefined()
    expect(second.path).toBe(dir)

    expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalledTimes(1)
    // dialog.showMessageBox supports both (window, options) and (options)
    // overloads; the options object is always the last argument.
    const call = vi.mocked(dialog.showMessageBox).mock.calls[0]! as unknown as unknown[]
    const opts = call[call.length - 1] as {
      type?: string
      title?: string
      detail?: string
    }
    expect(opts.type).toBe('info')
    expect(opts.title ?? '').toContain('项目已存在')
    // The detail field should reference the offending directory so the user
    // can see what they tried to import.
    expect(opts.detail ?? '').toContain(dir)

    // The list still has exactly one entry for this path.
    const listAfterSecond = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(listAfterSecond.filter((p) => p.path === dir)).toHaveLength(1)

    await instance.dispose()
  })

  it('invalid directory (no app.json) throws and shows an error dialog with title 无法导入项目', async () => {
    const dir = '/tmp/projInvalid'
    // Deliberately do NOT add to projectsWithAppJson — validateProjectDir fails.
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createWorkbenchApp({}).setup()
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    let caught: unknown
    try {
      await invokeHandler(sender, ProjectsChannel.Add, dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()

    // Find the error dialog among (possibly multiple) showMessageBox calls.
    // The handler is allowed to also surface non-fatal warnings (e.g. an
    // unparseable project.config.json) before throwing — what we care about
    // is that the user gets exactly one error dialog with the expected title.
    expect(vi.mocked(dialog.showMessageBox).mock.calls.length).toBeGreaterThan(0)
    const errorCalls = vi.mocked(dialog.showMessageBox).mock.calls
      .map((call) => (call as unknown as unknown[])[(call as unknown as unknown[]).length - 1] as {
        type?: string
        title?: string
      })
      .filter((opts) => opts.type === 'error')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0]!.title).toBe('无法导入项目')

    // Persisted list is unchanged.
    const list = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(list.filter((p) => p.path === dir)).toHaveLength(0)

    await instance.dispose()
  })
})
