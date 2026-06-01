/**
 * Dual-target CDP connection manager.
 *
 * The MCP server connects to two Chrome DevTools Protocol targets in parallel:
 *   - `simulator`: the in-app simulator `<webview>` (identified by its URL)
 *   - `workbench`: the workbench main renderer window
 *
 * Each target keeps:
 *   - a CDP client (reconnected automatically when the target disappears)
 *   - rolling buffers of console log and network request events
 */

import CDP from 'chrome-remote-interface'
import { DEFAULT_CDP_PORT } from '../../../shared/constants.js'

const SIMULATOR_URL_PATTERN = 'localhost:7788'
// Native-host: the real mini-app page runs in a nested render-host <webview>
// guest whose CDP target URL carries the render frame + the page's bridgeId.
const RENDER_GUEST_PATTERN = 'pageFrame.html'
const MAX_BUFFER = 500
const RECONNECT_INTERVAL_MS = 3000

export type TargetKind = 'simulator' | 'workbench'

export interface ConsoleLogEntry {
  level: string
  text: string
  timestamp: string
}

export interface NetworkRequestEntry {
  url: string
  method: string
  status: number
  mimeType: string
  responseSize: number
  timing: { requestTime: number; receiveHeadersEnd: number } | null
}

interface TargetState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
  connected: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timer: any
  consoleLogs: ConsoleLogEntry[]
  networkRequests: NetworkRequestEntry[]
}

let cdpPort = DEFAULT_CDP_PORT

// Native-host mode: the simulator target is the active render-host <webview>
// guest (pageFrame.html?...bridgeId=<id>) rather than the localhost:7788 shell.
let nativeHostMode = false
// The visible page's bridgeId, pushed from the bridge-router render events.
// `selectSimulatorTarget` prefers the guest matching this id so MCP follows
// the active page across navigation/tab switches.
let activeBridgeId: string | null = null

const targets: Record<TargetKind, TargetState> = {
  simulator: { client: null, connected: false, timer: null, consoleLogs: [], networkRequests: [] },
  workbench:  { client: null, connected: false, timer: null, consoleLogs: [], networkRequests: [] },
}

export function setCdpPort(port: number): void {
  cdpPort = port
}

export function setNativeHost(enabled: boolean): void {
  nativeHostMode = enabled
}

/**
 * Update the active-page bridgeId so the `simulator` target follows the
 * currently visible render guest. No-op when unchanged. When native-host is
 * on and the simulator target is already connected, fire-and-forget a
 * reconnect so MCP re-points at the new active page.
 */
export function setActiveBridgeId(id: string | null): void {
  if (id === activeBridgeId) return
  activeBridgeId = id
  if (nativeHostMode && targets.simulator.connected) {
    void connectTarget('simulator')
  }
}

/**
 * Resolve which CDP target the `simulator` MCP tools should drive.
 *
 * Default (non-native) path: the localhost:7788 simulator shell — identical
 * to the original behavior; `activeBridgeId` is ignored.
 *
 * Native-host path: the active render-host <webview> guest
 * (pageFrame.html?...bridgeId=<id>), preferring the guest matching
 * `activeBridgeId`, then any pageFrame guest, then degrading to the shell.
 */
export function selectSimulatorTarget<T extends { url?: string; type?: string }>(
  targets: T[],
  opts: { nativeHost: boolean; activeBridgeId: string | null },
): T | undefined {
  if (!opts.nativeHost) {
    return targets.find((t) => t.url?.includes(SIMULATOR_URL_PATTERN))
  }

  // 1) Active-bridge guest takes priority over list order.
  if (opts.activeBridgeId !== null) {
    const bridgeMatch = `bridgeId=${opts.activeBridgeId}`
    const active = targets.find(
      (t) => t.url?.includes(RENDER_GUEST_PATTERN) && t.url.includes(bridgeMatch),
    )
    if (active) return active
  }

  // 2) Any render guest (no active match / no active bridge).
  const anyGuest = targets.find((t) => t.url?.includes(RENDER_GUEST_PATTERN))
  if (anyGuest) return anyGuest

  // 3) Degrade to the localhost:7788 shell when no render guest exists yet.
  return targets.find((t) => t.url?.includes(SIMULATOR_URL_PATTERN))
}

export function getTargetState(kind: TargetKind): TargetState {
  return targets[kind]
}

async function listCdpTargets() {
  try {
    return await CDP.List({ port: cdpPort })
  } catch {
    return []
  }
}

export { listCdpTargets as listTargets }

function findTarget(allTargets: Awaited<ReturnType<typeof CDP.List>>, kind: TargetKind) {
  if (kind === 'simulator') {
    return selectSimulatorTarget(allTargets, { nativeHost: nativeHostMode, activeBridgeId })
  }
  // workbench main window: page target whose URL contains index.html (renderer)
  return allTargets.find(
    (t) => t.type === 'page' && t.url?.includes('entries/main/index.html') && !t.url?.includes(SIMULATOR_URL_PATTERN)
  )
}

export async function connectTarget(kind: TargetKind): Promise<void> {
  const state = targets[kind]

  if (state.client) {
    try { await state.client.close() } catch {}
    state.client = null
  }

  const allTargets = await listCdpTargets()
  const target = findTarget(allTargets, kind)
  if (!target) {
    state.connected = false
    scheduleReconnect(kind)
    return
  }

  let client: CDP.Client | null = null
  try {
    client = await CDP({ port: cdpPort, target })

    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable(),
      client.Network.enable(),
      client.Console.enable(),
    ])

    // Network buffer
    const pending = new Map<string, { url: string; method: string; timestamp: number }>()
    const pushNetworkRequest = (entry: NetworkRequestEntry) => {
      state.networkRequests.push(entry)
      if (state.networkRequests.length > MAX_BUFFER) state.networkRequests = state.networkRequests.slice(-MAX_BUFFER)
    }

    // Console buffer
    client.Runtime.on('consoleAPICalled', (params: { type: string; args: Array<{ value?: unknown; description?: string }>; timestamp: number }) => {
      const entry: ConsoleLogEntry = {
        level: params.type,
        text: params.args.map((a) => String(a.value ?? a.description ?? JSON.stringify(a))).join(' '),
        timestamp: new Date(params.timestamp).toISOString(),
      }
      state.consoleLogs.push(entry)
      if (state.consoleLogs.length > MAX_BUFFER) state.consoleLogs = state.consoleLogs.slice(-MAX_BUFFER)
    })

    client.Console.on('messageAdded', (params: { message: { level: string; text: string } }) => {
      const msg = params.message
      state.consoleLogs.push({ level: msg.level, text: msg.text, timestamp: new Date().toISOString() })
      if (state.consoleLogs.length > MAX_BUFFER) state.consoleLogs = state.consoleLogs.slice(-MAX_BUFFER)
    })

    client.Network.on('requestWillBeSent', (params: { requestId: string; request: { url: string; method: string }; timestamp: number }) => {
      pending.set(params.requestId, { url: params.request.url, method: params.request.method, timestamp: params.timestamp })
    })
    client.Network.on('responseReceived', (params: { requestId: string; response: { status: number; mimeType: string; encodedDataLength: number; timing?: { requestTime: number; receiveHeadersEnd: number } } }) => {
      const req = pending.get(params.requestId)
      if (!req) return
      pending.delete(params.requestId)
      pushNetworkRequest({
        url: req.url, method: req.method,
        status: params.response.status, mimeType: params.response.mimeType,
        responseSize: params.response.encodedDataLength || 0,
        timing: params.response.timing
          ? { requestTime: params.response.timing.requestTime, receiveHeadersEnd: params.response.timing.receiveHeadersEnd }
          : null,
      })
    })
    client.Network.on('loadingFailed', (params: { requestId: string }) => {
      const req = pending.get(params.requestId)
      if (!req) return
      pending.delete(params.requestId)
      pushNetworkRequest({
        url: req.url,
        method: req.method,
        status: 0,
        mimeType: '',
        responseSize: 0,
        timing: null,
      })
    })

    client.on('disconnect', () => {
      state.connected = false
      state.client = null
      scheduleReconnect(kind)
    })

    state.client = client
    state.connected = true

    if (state.timer) { clearTimeout(state.timer); state.timer = null }
  } catch {
    if (client) {
      try { await client.close() } catch {}
    }
    state.client = null
    state.connected = false
    scheduleReconnect(kind)
  }
}

function scheduleReconnect(kind: TargetKind): void {
  const state = targets[kind]
  if (state.timer) return
  state.timer = setTimeout(async () => {
    state.timer = null
    await connectTarget(kind)
  }, RECONNECT_INTERVAL_MS)
}

export function getClient(kind: TargetKind) {
  const state = targets[kind]
  if (!state.connected || !state.client) {
    const label = kind === 'simulator' ? '模拟器' : '主窗口'
    throw new Error(`未连接到${label}。请确保 dimina-devtools 正在以开发模式运行。`)
  }
  return state.client
}
