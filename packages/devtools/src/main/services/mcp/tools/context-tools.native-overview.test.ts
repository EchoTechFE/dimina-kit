import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerContextTools } from './context-tools.js'
import {
  getTargetState,
  setNativeHost,
  setNativeOverviewProvider,
  type NativeOverview,
} from '../target-manager.js'

/**
 * Native-host overview contract (TDD).
 *
 * Under native-host the mini-app is split across processes; the in-target CDP
 * probe that `simulator_get_overview` runs is blind to page-stack / route /
 * storage / appdata state, so it returns zeros & empties even when pages are
 * open and storage is written. The fix exposes a module-level
 * `setNativeOverviewProvider` whose values the overview must merge in.
 *
 * This test pins the OUTPUT contract only: with native-host on, a connected
 * simulator target whose CDP probe is blind (pageStackDepth:0, route:null,
 * empty storage/appdata), plus a native overview provider that DOES know the
 * cross-process state, the returned overview must reflect the provider's
 * non-zero pageStackDepth, non-null currentRoute, and populated
 * storageKeys/storageCount/appDataKeys — not the blind zeros.
 *
 * Deterministic vitest integration test (no Electron): we drive
 * `registerContextTools` against a fake `McpServer`, capture the
 * `simulator_get_overview` handler, inject a connected fake CDP client whose
 * `Runtime.evaluate` returns the CDP-blind probe, set a known native provider,
 * invoke the tool, and assert the merged payload.
 *
 * MAY-NOT: this test never reads the overview-merge body; it asserts only the
 * documented behavior.
 */

// Minimal fake McpServer: capture each registered tool's handler so we can
// invoke `simulator_get_overview` directly. `server.tool(name, desc, schema, handler)`.
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
  // registerContextTools is typed against McpServer; only `.tool` is exercised.
  return { server: server as unknown as Parameters<typeof registerContextTools>[0], handlers }
}

// The CDP-blind probe that the in-target evaluate returns under native-host:
// pages ARE open and storage IS written, but this in-process probe can't see
// any of it. Mirrors the SIMULATOR_PROBE_EXPR default shape.
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

// A connected fake CDP client whose Runtime.evaluate returns the blind probe.
function injectConnectedBlindSimulator() {
  const state = getTargetState('simulator')
  state.connected = true
  state.client = {
    Runtime: {
      evaluate: async () => ({ result: { value: JSON.stringify(BLIND_PROBE) } }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  // Keep the rolling buffers empty so console/network summaries are deterministic.
  state.consoleLogs = []
  state.networkRequests = []
}

function resetSimulatorState() {
  const state = getTargetState('simulator')
  state.connected = false
  state.client = null
  state.consoleLogs = []
  state.networkRequests = []
}

async function callOverview(handlers: Map<string, ToolHandler>): Promise<Record<string, unknown>> {
  const handler = handlers.get('simulator_get_overview')
  expect(handler, 'simulator_get_overview must be registered').toBeTypeOf('function')
  const res = await handler!({})
  const text = res.content.find((c) => c.type === 'text')?.text
  expect(text, 'overview must return a text payload').toBeTypeOf('string')
  return JSON.parse(text as string) as Record<string, unknown>
}

describe('simulator_get_overview — native-host cross-process fields', () => {
  beforeEach(() => {
    setNativeHost(true)
    setNativeOverviewProvider(null)
    injectConnectedBlindSimulator()
  })

  afterEach(() => {
    setNativeHost(false)
    setNativeOverviewProvider(null)
    resetSimulatorState()
  })

  it('merges the native provider: pageStackDepth>0, currentRoute set, storage & appdata populated', async () => {
    const native: NativeOverview = {
      currentRoute: 'pages/detail/detail?id=42',
      pageStackDepth: 3,
      storageKeys: ['token', 'profile', 'cart'],
      storageCount: 3,
      appDataKeys: ['list', 'loading'],
    }
    setNativeOverviewProvider(async () => native)

    const { server, handlers } = makeFakeServer()
    registerContextTools(server)

    const payload = await callOverview(handlers)

    // The blind in-target probe reported zeros/null/empties; the merged
    // overview must reflect the native (main-process) state instead.
    expect(payload.pageStackDepth).toBe(3)
    expect(payload.currentRoute).toBe('pages/detail/detail?id=42')
    expect(payload.storageKeys).toEqual(
      expect.arrayContaining(['token', 'profile', 'cart']),
    )
    expect(payload.storageCount).toBe(3)
    expect(payload.appDataKeys).toEqual(expect.arrayContaining(['list', 'loading']))

    // And specifically NOT the blind defaults.
    expect(payload.pageStackDepth).not.toBe(0)
    expect(payload.currentRoute).not.toBeNull()
    expect(payload.storageKeys).not.toEqual([])
  })

  it('without a native provider the cross-process fields stay blind (pins the bug seam)', async () => {
    // No provider set (beforeEach left it null) → today's native-host behavior:
    // the overview can only see the CDP-blind probe.
    const { server, handlers } = makeFakeServer()
    registerContextTools(server)

    const payload = await callOverview(handlers)

    expect(payload.pageStackDepth).toBe(0)
    expect(payload.currentRoute).toBeNull()
    expect(payload.storageKeys).toEqual([])
    expect(payload.storageCount).toBe(0)
    expect(payload.appDataKeys).toEqual([])
  })
})
