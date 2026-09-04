/**
 * `simulator_get_overview` must read the native overview provider of the
 * window it was CALLED for, not whichever window happens to be active by the
 * time the in-target CDP probe resolves.
 *
 * The tool awaits `Runtime.evaluate` before reading `getNativeOverviewProvider()`,
 * which resolves the active window live off `resolveActiveOwner()`. If the
 * user switches project windows while that evaluate is in flight, the
 * provider read after the await belongs to the NEW active window even though
 * `getClient('simulator')` (and the probe itself) answered for the window
 * active when the call started — mixing window A's page/storage probe with
 * window B's route/stack overview in one response.
 *
 * The fix is to snapshot the provider (or the owning window) at the same
 * point `getClient` is read, before any await.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerContextTools } from './context-tools.js'
import {
  getTargetState,
  registerMcpWindow,
  setActiveMcpWindowResolver,
  type McpWindowRegistration,
  type NativeOverview,
} from '../target-manager.js'

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}>

function makeFakeServer() {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  }
  return { server: server as unknown as Parameters<typeof registerContextTools>[0], handlers }
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const BLIND_PROBE = {
  url: 'file:///app/dist/render-host/pageFrame.html?appId=x&bridgeId=b1',
  title: 'page',
  viewport: { width: 390, height: 844 },
  currentRoute: null as string | null,
  pageStackDepth: 0,
  storageKeys: [] as string[],
  storageCount: 0,
  appDataKeys: [] as string[],
  bridgeReady: false,
  simulatorDataPresent: false,
}

const overviewFor = (route: string): NativeOverview => ({
  currentRoute: route,
  pageStackDepth: 1,
  storageKeys: [],
  storageCount: 0,
  appDataKeys: [],
})

function resetSimulatorState() {
  const state = getTargetState('simulator')
  state.connected = false
  state.client = null
  state.owner = null
  state.consoleLogs = []
  state.networkRequests = []
}

async function callOverview(handlers: Map<string, ToolHandler>) {
  const handler = handlers.get('simulator_get_overview')
  expect(handler, 'simulator_get_overview must be registered').toBeTypeOf('function')
  return handler!({})
}

const windowA = {}
const windowB = {}
let registrationA: McpWindowRegistration
let registrationB: McpWindowRegistration

describe('simulator_get_overview provider snapshot vs. mid-flight window switch', () => {
  beforeEach(() => {
    registrationA = registerMcpWindow(windowA, {
      nativeHost: true, activeBridgeId: null,
      nativeOverviewProvider: async () => overviewFor('pages/A'),
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })
    registrationB = registerMcpWindow(windowB, {
      nativeHost: true, activeBridgeId: null,
      nativeOverviewProvider: async () => overviewFor('pages/B'),
      projectPath: '/proj/b', getAppId: () => 'app-b',
    })
  })

  afterEach(() => {
    registrationA.dispose()
    registrationB.dispose()
    setActiveMcpWindowResolver(() => null)
    resetSimulatorState()
  })

  it('reports A`s route even when the active window switches to B before the CDP probe resolves', async () => {
    setActiveMcpWindowResolver(() => windowA)

    const state = getTargetState('simulator')
    state.connected = true
    state.owner = windowA
    const deferred = makeDeferred<{ result: { value: string } }>()
    state.client = {
      Runtime: { evaluate: async () => deferred.promise },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const { server, handlers } = makeFakeServer()
    registerContextTools(server)

    // Call starts while A is active: getClient('simulator') reads A's
    // connection synchronously, before the probe's await suspends the tool.
    const resultPromise = callOverview(handlers)

    // The user switches windows while the probe is still in flight.
    setActiveMcpWindowResolver(() => windowB)
    deferred.resolve({ result: { value: JSON.stringify(BLIND_PROBE) } })

    const res = await resultPromise
    const text = res.content.find((c) => c.type === 'text')?.text
    const payload = JSON.parse(text as string) as Record<string, unknown>

    expect(
      payload.currentRoute,
      'the overview was requested for A (getClient answered for A before the switch); it must not silently report B`s route',
    ).toBe('pages/A')
    expect(payload.currentRoute).not.toBe('pages/B')
  })

  it('reports A`s console error even when a reconnect clears and re-owns the shared buffer while the native provider is in flight', async () => {
    setActiveMcpWindowResolver(() => windowA)

    const state = getTargetState('simulator')
    state.connected = true
    state.owner = windowA
    state.bufferOwner = windowA
    state.consoleLogs = [{ level: 'error', text: 'A boom', timestamp: '2026-01-01T00:00:00.000Z' }]
    state.networkRequests = []
    state.client = {
      Runtime: { evaluate: async () => ({ result: { value: JSON.stringify(BLIND_PROBE) } }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    let providerCalled = false
    const providerDeferred = makeDeferred<NativeOverview>()
    registrationA = registerMcpWindow(windowA, {
      nativeHost: true, activeBridgeId: null,
      nativeOverviewProvider: () => { providerCalled = true; return providerDeferred.promise },
      projectPath: '/proj/a', getAppId: () => 'app-a',
    })

    const { server, handlers } = makeFakeServer()
    registerContextTools(server)

    const resultPromise = callOverview(handlers)
    await vi.waitFor(() => {
      expect(providerCalled, 'the overview must reach the native provider await before the buffer is mutated below').toBe(true)
    })

    // A reconnect to B lands while A's native provider is still pending —
    // target-manager clears the shared console/network buffer and re-owns it
    // for B before A's own await settles.
    state.consoleLogs = []
    state.networkRequests = []
    state.bufferOwner = windowB
    state.owner = windowB
    state.consoleLogs.push({ level: 'error', text: 'B boom', timestamp: '2026-01-01T00:00:01.000Z' })
    setActiveMcpWindowResolver(() => windowB)

    providerDeferred.resolve(overviewFor('pages/A'))

    const res = await resultPromise
    const text = res.content.find((c) => c.type === 'text')?.text
    const payload = JSON.parse(text as string) as Record<string, unknown>
    const lastError = payload.lastError as { text: string } | null

    expect(
      lastError?.text,
      'the console summary must reflect the buffer as it stood when this overview call started, not whatever it was cleared and refilled with while the call was still in flight',
    ).toBe('A boom')
    expect(payload.recentErrorCount).toBe(1)
  })
})
