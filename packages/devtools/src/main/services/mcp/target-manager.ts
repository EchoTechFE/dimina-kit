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
import { DMB_PAGEFRAME_DOC_NAME } from '../../../shared/dmb-resource-url.js'
import { connectionOwner, targetQuery, type TargetIdentityFacts } from './connection-owner.js'

const SIMULATOR_URL_PATTERN = 'localhost:7788'
// The two renderer entries MCP can drive: a project's workbench window and the
// always-present project list.
const WORKBENCH_ENTRY = 'entries/workbench/index.html'
const PROJECT_LIST_ENTRY = 'entries/main/index.html'
// Native-host: the real mini-app page runs in a nested render-host <webview>
// guest whose CDP target URL carries the render frame + the page's bridgeId.
// Import the shared reserved doc name rather than hand-writing a second
// literal — that duplication is exactly what let this pattern drift out of
// sync with the actual document URL shape (dmb-resource-url.ts).
const RENDER_GUEST_PATTERN = DMB_PAGEFRAME_DOC_NAME
const MAX_BUFFER = 500
const RECONNECT_INTERVAL_MS = 3000
// How long a burst of focus changes is allowed to settle before the live
// connections are re-aimed.
const ACTIVE_WINDOW_SETTLE_MS = 150

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

export interface NativeOverview {
  currentRoute: string | null
  pageStackDepth: number
  storageKeys: string[]
  storageCount: number
  appDataKeys: string[]
}

export type NativeOverviewProvider = () => Promise<NativeOverview>

interface TargetState {
  client: CDP.Client | null
  connected: boolean
  timer: ReturnType<typeof setTimeout> | null
  consoleLogs: ConsoleLogEntry[]
  networkRequests: NetworkRequestEntry[]
}

let cdpPort = DEFAULT_CDP_PORT

/**
 * What MCP needs to know about ONE project window.
 *
 * Every project runs in its own window, so native-host mode, the visible
 * render guest, the cross-process overview provider and the project identity
 * are facts about a single window — never about the process. A window
 * publishes its own record here and drops only that record when it closes.
 */
export interface McpWindowFacts extends TargetIdentityFacts {
  /** The window runs the native-host runtime (mini-app pages live in nested render guests). */
  nativeHost: boolean
  /**
   * The visible page's bridgeId, pushed from this window's bridge-router
   * render events. `selectSimulatorTarget` prefers the guest matching it so
   * MCP follows the active page across navigation/tab switches.
   */
  activeBridgeId: string | null
  nativeOverviewProvider: NativeOverviewProvider | null
  /** Absolute path of the project open in this window; '' before its session exists. */
  getProjectPath: () => string
  /** appId of the project open in this window; null before its session exists. */
  getAppId: () => string | null
}

export interface McpWindowRegistration {
  facts: McpWindowFacts
  dispose: () => void
}

const windowFacts = new Map<object, McpWindowFacts>()
let resolveActiveOwner: () => object | null = () => null

/**
 * Point MCP at the window the user is working in. Assembled once by the app;
 * `owner` is the opaque token a window registered itself under. Resolving to
 * null means no project window is open, which is the answer MCP reports before
 * the first project is opened.
 */
export function setActiveMcpWindowResolver(resolve: () => object | null): void {
  resolveActiveOwner = resolve
}

export function registerMcpWindow(owner: object, facts: McpWindowFacts): McpWindowRegistration {
  windowFacts.set(owner, facts)
  return {
    facts,
    dispose: () => {
      // Only this window's record: other project windows may still be open and
      // their native-host state has to survive this teardown.
      if (windowFacts.get(owner) === facts) windowFacts.delete(owner)
    },
  }
}

/** The facts of the project window MCP currently drives, or null when none is open. */
export function activeMcpWindow(): McpWindowFacts | null {
  const owner = resolveActiveOwner()
  return (owner !== null && windowFacts.get(owner)) || null
}

/**
 * Record the render guest now visible in `owner`'s window. Re-points the live
 * simulator connection only when that window is the one MCP drives — a
 * navigation in a background project window must not steal the target.
 */
export function noteActiveBridgeId(owner: object, id: string | null): void {
  const facts = windowFacts.get(owner)
  if (!facts || facts.activeBridgeId === id) return
  facts.activeBridgeId = id
  if (facts.nativeHost && resolveActiveOwner() === owner && targets.simulator.connected) {
    void connectTarget('simulator')
  }
}

/**
 * The active project window changed. A connection that is already established
 * was aimed at whichever window was active when it was made, and nothing
 * re-read that afterwards — so without this the MCP tools keep reporting and
 * driving the project the user has left. Only connections bound to a different
 * window are re-aimed; the rest are left alone.
 *
 * Coalesced on purpose: clicking across windows produces a burst of these, and
 * re-resolving once the burst settles means focus that returns to the window a
 * connection already holds costs nothing.
 */
export function noteActiveMcpWindowChanged(): void {
  if (repointTimer) return
  repointTimer = setTimeout(() => {
    repointTimer = null
    const owner = resolveActiveOwner()
    // A window whose facts are already gone is on its way out: its pages are
    // about to be destroyed, so connecting into them would only produce a
    // client that immediately disconnects. The reconnect timer picks up
    // whichever window replaces it.
    if (owner !== null && !windowFacts.has(owner)) return
    for (const kind of Object.keys(targets) as TargetKind[]) {
      if (!targets[kind].connected || connectedOwner[kind] === owner) continue
      void connectTarget(kind)
    }
  }, ACTIVE_WINDOW_SETTLE_MS)
}

// The two CDP connections are process-wide on purpose: MCP exposes one
// `simulator` and one `workbench` target with no window argument, so both
// always mean "the project the user is working in". Which window that is comes
// from `activeMcpWindow()` on every (re)connect, so the pair follows the
// active window rather than belonging to any one of them.
const targets: Record<TargetKind, TargetState> = {
  simulator: { client: null, connected: false, timer: null, consoleLogs: [], networkRequests: [] },
  workbench:  { client: null, connected: false, timer: null, consoleLogs: [], networkRequests: [] },
}

/**
 * The window each live connection ACTUALLY reached — not the one it was aimed
 * at. Target selection degrades to another project's surface when it cannot
 * find the active window's, and recording that as an arrival is what leaves
 * MCP driving the wrong project with nothing to correct it. Null means the
 * target names no project window.
 */
const connectedOwner: Record<TargetKind, object | null> = { simulator: null, workbench: null }
/** Monotonic per target: only the newest connect attempt may publish itself. */
const connectGeneration: Record<TargetKind, number> = { simulator: 0, workbench: 0 }
let repointTimer: ReturnType<typeof setTimeout> | null = null

export function setCdpPort(port: number): void {
  cdpPort = port
}

/** The cross-process overview reader of the window MCP drives, if it has one. */
export function getNativeOverviewProvider(): NativeOverviewProvider | null {
  return activeMcpWindow()?.nativeOverviewProvider ?? null
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

/**
 * Resolve which CDP target the `workbench` MCP tools should drive.
 *
 * `projectPath` is the active project window's path: null when no project
 * window is open (the project list is then the only workbench surface), and
 * '' for a window whose compile has not recorded a path yet.
 *
 * Matching is on the renderer ENTRY, never on "the URL mentions the project
 * directory" — the service-host window carries the same directory in its own
 * `pkgRoot` query and would win a substring match.
 */
export function selectWorkbenchTarget<T extends { url?: string; type?: string }>(
  candidates: T[],
  opts: { projectPath: string | null },
): T | undefined {
  const pages = candidates.filter(
    (t) => t.type === 'page' && !t.url?.includes(SIMULATOR_URL_PATTERN),
  )
  const projectList = pages.find((t) => t.url?.includes(PROJECT_LIST_ENTRY))
  if (opts.projectPath === null) return projectList

  const workbenches = pages.filter((t) => t.url?.includes(WORKBENCH_ENTRY))
  const exact = opts.projectPath
    ? workbenches.find((t) => targetQuery(t.url, 'path') === opts.projectPath)
    : undefined
  return exact ?? workbenches[0] ?? projectList
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
  const active = activeMcpWindow()
  if (kind === 'simulator') {
    return selectSimulatorTarget(allTargets, {
      nativeHost: active?.nativeHost ?? false,
      activeBridgeId: active?.activeBridgeId ?? null,
    })
  }
  return selectWorkbenchTarget(allTargets, {
    projectPath: active ? active.getProjectPath() : null,
  })
}

/**
 * Console and network events into this target's ring buffers, which is all
 * these subscriptions do — they hold no view of which window is connected, so
 * they outlive nothing and need no generation check of their own.
 */
function subscribeBuffers(client: CDP.Client, state: TargetState): void {
  const pending = new Map<string, { url: string; method: string; timestamp: number }>()
  const pushNetworkRequest = (entry: NetworkRequestEntry) => {
    state.networkRequests.push(entry)
    if (state.networkRequests.length > MAX_BUFFER) state.networkRequests = state.networkRequests.slice(-MAX_BUFFER)
  }
  const pushConsoleLog = (entry: ConsoleLogEntry) => {
    state.consoleLogs.push(entry)
    if (state.consoleLogs.length > MAX_BUFFER) state.consoleLogs = state.consoleLogs.slice(-MAX_BUFFER)
  }

  client.Runtime.on('consoleAPICalled', (params: { type: string; args: Array<{ value?: unknown; description?: string }>; timestamp: number }) => {
    pushConsoleLog({
      level: params.type,
      text: params.args.map((a) => String(a.value ?? a.description ?? JSON.stringify(a))).join(' '),
      timestamp: new Date(params.timestamp).toISOString(),
    })
  })

  client.Console.on('messageAdded', (params: { message: { level: string; text: string } }) => {
    const msg = params.message
    pushConsoleLog({ level: msg.level, text: msg.text, timestamp: new Date().toISOString() })
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
    pushNetworkRequest({ url: req.url, method: req.method, status: 0, mimeType: '', responseSize: 0, timing: null })
  })
}

/** Closing a client is never the reason an attempt fails. */
async function closeQuietly(client: CDP.Client | null): Promise<void> {
  if (!client) return
  try { await client.close() } catch {}
}

/** No usable target right now: publish nothing and keep retrying. */
function loseTarget(kind: TargetKind): void {
  const state = targets[kind]
  state.client = null
  state.connected = false
  connectedOwner[kind] = null
  scheduleReconnect(kind)
}

/**
 * Publish a connection that survived the race, recording the window it
 * actually reached. The owner is resolved here, not when the attempt started:
 * an attempt that outlived a window switch has to be judged against the window
 * the user is in now.
 */
function publishConnection(kind: TargetKind, client: CDP.Client, url: string | undefined): void {
  const state = targets[kind]
  const binding = connectionOwner(kind, url, resolveActiveOwner(), windowFacts)
  state.client = client
  state.connected = true
  connectedOwner[kind] = binding.owner

  if (!binding.onTarget) {
    // Usable but not the window the user is in — the exact target may still be
    // loading, or its project path may not be recorded yet. Keep retrying so
    // the connection lands there on its own.
    scheduleReconnect(kind)
    return
  }
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
}

export async function connectTarget(kind: TargetKind): Promise<void> {
  const state = targets[kind]
  // Establishing a connection is a long chain of awaits, and the reason to
  // establish it — which window is active, which page it shows — can change
  // while that chain runs. An attempt overtaken by a newer one must publish
  // nothing, close the client it opened, and schedule no work.
  const generation = (connectGeneration[kind] += 1)
  const superseded = () => connectGeneration[kind] !== generation

  if (state.client) {
    const previous = state.client
    state.client = null
    await closeQuietly(previous)
    if (superseded()) return
  }

  const allTargets = await listCdpTargets()
  const target = findTarget(allTargets, kind)
  if (superseded()) return
  if (!target) {
    loseTarget(kind)
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

    // Everything below subscribes or publishes, so an attempt that lost the
    // race stops here and leaves nothing behind but its own closed client.
    if (superseded()) {
      await closeQuietly(client)
      return
    }

    subscribeBuffers(client, state)

    client.on('disconnect', () => {
      // A superseded client is closed on purpose; only the live connection
      // going away means MCP has lost its target.
      if (superseded()) return
      state.connected = false
      state.client = null
      scheduleReconnect(kind)
    })

    publishConnection(kind, client, target.url)
  } catch {
    await closeQuietly(client)
    if (superseded()) return
    loseTarget(kind)
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
