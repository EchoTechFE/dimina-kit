/**
 * `workbench(config)` — the host-shell entry (workbench-model.md). Per the
 * foundation's dependency direction it lives in `@dimina-kit/devtools` (not
 * `@dimina-kit/workbench`) so it can drive the devtools runtime without a
 * `workbench → devtools` cycle; hosts import it from `@dimina-kit/devtools`.
 *
 * It composes the four building blocks (config adapter / wire bridge /
 * contributions binding / runtime facade) on top of `createWorkbenchApp`:
 *  1. map `WorkbenchConfig` → `WorkbenchAppConfig`, split deferred contributions
 *  2. assemble the devtools runtime (`createWorkbenchApp().setup()`)
 *  3. stand up the host-shell WireTransport over devtools' real ipcMain
 *  4. bind hostServices / events / simulatorApis
 *  5. load the host-owned toolbar (host controls its preload)
 *  6. hand the host a `Runtime` facade in `config.setup(runtime)`
 *
 * Minimal-entry gaps (documented; not yet wired): declared `config.windows`
 * (`runtime.windows.get` returns undefined), the `FrameworkEvents` bus has no
 * emitters yet (`runtime.on` listeners never fire), and `runtime.toolbarView`
 * is null (the host drives the toolbar via `config.toolbar` + its own preload).
 */
import type { BrowserWindow } from 'electron'

import {
  EventBus,
  InMemoryTypedIpcRegistry,
  WireTransport,
  validateConfig,
  type MinimalIpcMain,
  type MinimalWebContents,
} from '@dimina-kit/workbench/host'
import type {
  JsonValue,
  Runtime,
  TypedIpcRegistry,
  WorkbenchConfig,
  WorkbenchOptions,
} from '@dimina-kit/workbench'

import { buildRuntime } from '../runtime/build-runtime.js'
import { createWorkbenchApp } from './app.js'
import { bindContributions } from './workbench-bindings.js'
import { toWorkbenchAppConfig } from './workbench-config-adapter.js'
import { buildWireTransportOptions } from './workbench-wire-bridge.js'

const HOST_CHANNEL_PREFIX = '__workbench:host:'

/**
 * `options` exists for parity with the spec signature; the devtools entry always
 * assembles against the real Electron main process (test injection is not
 * supported here — unit coverage lives on the composed building blocks).
 */
export async function workbench(config: WorkbenchConfig, _options?: WorkbenchOptions): Promise<void> {
  validateConfig(config)
  const { appConfig, deferred } = toWorkbenchAppConfig(config)

  const appHandle = createWorkbenchApp(appConfig)
  // start() registers the Electron app lifecycle and awaits the (memoized)
  // setup; setup() then returns the same assembled instance immediately. We
  // await start() rather than floating it so a setup failure surfaces here once,
  // not as a separate unhandled rejection.
  await appHandle.start()
  const instance = await appHandle.setup()
  const ctx = instance.context

  // Host-shell transport over devtools' real ipcMain + authoritative trust set.
  const wireOpts = buildWireTransportOptions(ctx)
  const bus = new EventBus()
  const ipc = new InMemoryTypedIpcRegistry()

  // Bind contributions BEFORE the wire starts so host-service handlers exist
  // before any invoke can arrive over ipcMain.
  const bindings = bindContributions({ ctx, deferred, ipc, bus })
  ctx.registry.add(bindings)

  const transport = new WireTransport({
    ipcMain: wireOpts.ipcMain as unknown as MinimalIpcMain,
    bus,
    senderPolicy: wireOpts.senderPolicy,
    trustedWebContents: () =>
      wireOpts.trustedWebContents() as unknown as readonly MinimalWebContents[],
    invokeHost: (name, args) => ipc.invoke<JsonValue>(`${HOST_CHANNEL_PREFIX}${name}`, ...args),
    // devtools simulator APIs follow the `wx.<name>(params)` single-param
    // convention, so the registry takes one `params` argument (`args[0]`). The
    // wire's variadic simulator kind is not the devtools simulator path (the
    // simulator <webview> uses devtools' own bridge), so this routing is for
    // completeness; multi-arg simulator calls are not supported here.
    invokeSimulator: (name, args) =>
      ctx.simulatorApis.invoke(name, args[0]) as Promise<JsonValue>,
    declaredEvents: () => (deferred.events ? deferred.events.map((e) => e.name) : []),
  })
  transport.start()
  ctx.registry.add(() => transport.dispose())

  // Toolbar: the host fully owns the WebContentsView and its preload (which is
  // where it calls `exposeWorkbenchBridge()`). Set the host preload before the
  // first load so the lazily-created view picks it up. The load is best-effort
  // (a failure logs but does not reject — it must not leak the registered
  // transport/contributions nor block `workbench()`). `config.toolbar.height` is
  // fixed, so push it explicitly: the host preload may not run the built-in
  // size-advertiser, and without a pushed height the placeholder stays 0 and the
  // toolbar view never becomes visible.
  if (deferred.toolbar) {
    const tb = deferred.toolbar
    ctx.views.hostToolbar.setPreloadPath(tb.preloadPath)
    try {
      if ('url' in tb.source) await ctx.views.hostToolbar.loadURL(tb.source.url)
      else await ctx.views.hostToolbar.loadFile(tb.source.file)
    }
    catch (e) {
      console.error('[workbench] toolbar load failed:', e)
    }
    ctx.views.setHostToolbarHeight(tb.height)
  }

  // Runtime facade for the host's imperative escape.
  const electron = await import('electron')

  const createdWindows = new Set<BrowserWindow>()
  const windowsCtl: Runtime['windows'] = {
    create: (opts) => {
      const win = new electron.BrowserWindow({
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        ...(opts.modal !== undefined ? { modal: opts.modal } : {}),
        ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
        ...(opts.preloadPath !== undefined
          ? { webPreferences: { preload: opts.preloadPath } }
          : {}),
      })
      if ('url' in opts.source) void win.loadURL(opts.source.url)
      else void win.loadFile(opts.source.file)
      if (opts.autoTrust ?? true) instance.registerTrustedWindow(win)
      createdWindows.add(win)
      win.on('closed', () => createdWindows.delete(win))
      return win
    },
    // Declared `config.windows` are not assembled by the minimal entry.
    get: () => undefined,
    all: () => Array.from(createdWindows).filter((w) => !w.isDestroyed()),
    trust: (win) => instance.registerTrustedWindow(win),
  }

  // FrameworkEvents bus — no emitters wired yet (window-created/session-changed
  // etc. are deferred); listeners register but do not fire in the minimal entry.
  const fwListeners = new Map<string, Set<(p: unknown) => void>>()
  const busOn = (<E extends string>(event: E, listener: (p: unknown) => void) => {
    let set = fwListeners.get(event)
    if (!set) {
      set = new Set()
      fwListeners.set(event, set)
    }
    set.add(listener)
    return { dispose: () => { set!.delete(listener) } }
  }) as unknown as Runtime['on']

  const runtime = buildRuntime({
    electron,
    ctx,
    mainWindow: instance.mainWindow,
    // The raw toolbar WebContentsView is not surfaced by the minimal entry.
    toolbarView: null,
    ipc: ipc as unknown as TypedIpcRegistry,
    rawIpcMain: wireOpts.ipcMain,
    windowsCtl,
    busOn,
    callHost: (name, ...args) => bindings.callHost(name, ...args) as Promise<JsonValue>,
  })

  if (deferred.setup) {
    try {
      await deferred.setup(runtime)
    }
    catch (e) {
      // Host setup failed — tear the assembled app down (disposing the context
      // registry removes the WireTransport handlers + bound contributions)
      // before surfacing the error, so nothing leaks.
      await instance.dispose()
      throw e
    }
  }
}
