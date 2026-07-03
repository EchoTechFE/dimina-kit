/**
 * Session runtime status machine — 'launching' → 'running' transitions.
 *
 * The compile state machine (compiling/ready/error) is fine, but once a
 * session actually SPAWNS there is today no observable signal for "the
 * session exists but hasn't mounted yet" vs "it actually reached its root
 * page". This suite pins the first two legs of that machine:
 *
 *  1. `handleSpawn` completing must push `ctx.notify.sessionRuntimeStatus`
 *     with `{ appId, phase: 'launching' }`; when the requested start page
 *     was not mountable and `resolveRootPagePath` fell back to another page,
 *     the SAME event must carry `pageFallback: { requested, resolved }` so a
 *     UI banner can tell the developer their start page moved.
 *  2. The ROOT page's first `domReady` container message must push
 *     `{ appId, phase: 'running' }` — a NON-root page's `domReady` (e.g. a
 *     second page opened via PAGE_OPEN) must NOT flip the session to
 *     'running': only the root page proves the session actually mounted.
 *  3. A second `domReady` on the already-running root page must not re-fire
 *     the notification (idempotent — no duplicate 'running' pushes).
 *
 * Harness mirrors bridge-router-spawn-fallback.test.ts (fetch-mocked
 * app-config.json to control resolveRootPagePath's fallback) plus
 * bridge-router-app-lifecycle.test.ts's SERVICE_INVOKE dispatch for
 * domReady. `ctx.notify` is a spy object (the real `RendererNotifier` is not
 * needed — only the `sessionRuntimeStatus` method this suite exercises).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 9000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()

  function makeWebContents() {
    const em = makeEmitter()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }) }),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
      sentMessages: sent,
    }
    wcById.set(wc.id, wc)
    return wc
  }

  function makeBrowserWindow() {
    const em = makeEmitter()
    return {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
  }

  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []
  function createWindowForSpawn() {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 9000
  }

  return { onListeners, invokeHandlers, wcById, makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn, createdWindows, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn((channel: string, fn: AnyFn) => {
      ;(stubs.onListeners.get(channel) ?? stubs.onListeners.set(channel, new Set()).get(channel)!).add(fn)
    }),
    removeListener: vi.fn((channel: string, fn: AnyFn) => {
      stubs.onListeners.get(channel)?.delete(fn)
    }),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  const protocolStub = { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: protocolStub,
    session: sessionStub,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type {
  MessageEnvelope,
  PageOpenRequest,
  PageOpenResult,
  ServiceInvokePayload,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

interface SessionRuntimeStatusPayload {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  pageFallback?: { requested: string; resolved: string }
}

const APP_ID = 'test-app'
const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'
const BAD_PAGE = 'pages/removed/removed'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeAppConfigResponse(fixture: { entryPagePath?: string; pages?: string[] }): Response {
  const body = { app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages } }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

function makeOkEmpty(): Response {
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response
}

/** Wires app-config.json to `fixture`; logic.js always succeeds so boot proceeds past injection. */
function installFetchMock(fixture: { entryPagePath?: string; pages?: string[] }): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) return Promise.resolve(makeAppConfigResponse(fixture))
    if (href.includes('logic.js')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => '/* logic */', json: async () => ({}) } as unknown as Response)
    }
    return Promise.resolve(makeOkEmpty())
  }) as unknown as typeof fetch
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc; notify: { sessionRuntimeStatus: ReturnType<typeof vi.fn> } } {
  const simulatorWc = stubs.makeWebContents()
  const notify = { sessionRuntimeStatus: vi.fn() }
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    notify,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, notify }
}

async function spawnSession(
  simulatorWc: MockWc,
  pagePath: string,
): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc }
}

async function openNonRootPage(appSessionId: string, simulatorWc: MockWc, pagePath: string): Promise<PageOpenResult> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  const req: PageOpenRequest = { appSessionId, pagePath }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as PageOpenResult
}

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

function sendDomReady(serviceWc: MockWc, bridgeId: string): void {
  const msg: MessageEnvelope = { type: 'domReady', target: 'container', body: {} }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function runtimeStatusCalls(notify: { sessionRuntimeStatus: ReturnType<typeof vi.fn> }): SessionRuntimeStatusPayload[] {
  return notify.sessionRuntimeStatus.mock.calls.map(c => c[0] as SessionRuntimeStatusPayload)
}

describe('session runtime status — "launching" pushed when handleSpawn completes', () => {
  it('pushes { appId, phase: "launching" } with no pageFallback when the requested page mounts as-is', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    await spawnSession(simulatorWc, OTHER_PAGE)

    const calls = runtimeStatusCalls(notify)
    const launching = calls.find(c => c.phase === 'launching')
    expect(launching, `expected a "launching" push; got: ${JSON.stringify(calls)}`).toBeDefined()
    expect(launching!.appId).toBe(APP_ID)
    expect(launching!.pageFallback).toBeUndefined()
  })

  it('carries pageFallback: {requested, resolved} when the start page is not mountable and resolution fell back', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    await spawnSession(simulatorWc, BAD_PAGE)

    const calls = runtimeStatusCalls(notify)
    const launching = calls.find(c => c.phase === 'launching')
    expect(launching, `expected a "launching" push; got: ${JSON.stringify(calls)}`).toBeDefined()
    expect(
      launching!.pageFallback,
      'a resolved start-page fallback must be surfaced on the launching event so the UI can tell the developer',
    ).toEqual({ requested: BAD_PAGE, resolved: ENTRY_PAGE })
  })
})

describe('session runtime status — "running" pushed on the ROOT page\'s first domReady only', () => {
  it('pushes { appId, phase: "running" } when the ROOT page reports domReady', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] })
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)
    notify.sessionRuntimeStatus.mockClear()

    sendDomReady(serviceWc, result.bridgeId)
    await flush()

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.some(c => c.phase === 'running' && c.appId === APP_ID),
      `expected a "running" push after the root page's domReady; got: ${JSON.stringify(calls)}`,
    ).toBe(true)
  })

  it('does NOT push "running" when a NON-root page (opened via PAGE_OPEN) reports domReady', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)
    const nonRoot = await openNonRootPage(result.appSessionId, simulatorWc, OTHER_PAGE)
    notify.sessionRuntimeStatus.mockClear()

    sendDomReady(serviceWc, nonRoot.bridgeId)
    await flush()

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.some(c => c.phase === 'running'),
      `a non-root page's domReady must never flip the session to "running"; got: ${JSON.stringify(calls)}`,
    ).toBe(false)
  })

  it('does not re-push "running" on a SECOND domReady from the already-running root page', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] })
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)
    sendDomReady(serviceWc, result.bridgeId)
    await flush()
    notify.sessionRuntimeStatus.mockClear()

    sendDomReady(serviceWc, result.bridgeId)
    await flush()

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.filter(c => c.phase === 'running'),
      `a second domReady on an already-running root page must not re-fire "running"; got: ${JSON.stringify(calls)}`,
    ).toHaveLength(0)
  })
})
