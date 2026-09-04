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
import { connectionOwner, type TargetIdentityFacts } from './connection-owner.js'
import { selectSimulatorTarget, selectWorkbenchTarget } from './target-selection.js'

// Re-exported so existing `./target-manager.js` imports keep working — the
// candidate-ranking rules live in target-selection.ts, but callers reach them
// through the connection manager that uses them.
export { selectSimulatorTarget, selectWorkbenchTarget } from './target-selection.js'

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
  /**
   * The window this live connection ACTUALLY reached — not the one it was
   * aimed at, and null when the target names no project window (the project
   * list). Read on every `getClient`, so a connection left behind by a window
   * switch is refused instead of answering for the wrong project.
   */
  owner: object | null
  timer: ReturnType<typeof setTimeout> | null
  consoleLogs: ConsoleLogEntry[]
  networkRequests: NetworkRequestEntry[]
  /**
   * The owner these buffers were most recently cleared and populated for.
   * Distinct from `owner`, which goes null the instant a target is lost: a
   * reconnect that lands back on the same window (a transient CDP drop) must
   * find its buffers intact, so what decides whether to clear is this record
   * of the last owner they were published for, not the connection's current
   * live/dead state.
   */
  bufferOwner: object | null
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
  /** Absolute path of the project this window opened with; never changes. */
  projectPath: string
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
      if (!targets[kind].connected || targets[kind].owner === owner) continue
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
  simulator: { client: null, connected: false, owner: null, timer: null, consoleLogs: [], networkRequests: [], bufferOwner: null },
  workbench:  { client: null, connected: false, owner: null, timer: null, consoleLogs: [], networkRequests: [], bufferOwner: null },
}

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

/**
 * `selectWorkbenchTarget` already matches on the active window's exact
 * `projectPath`, so no candidate ranking is blind to ownership there — the
 * match is exact or nothing, with nothing left for a pre-filter to change.
 */
function findWorkbenchTarget(allTargets: Awaited<ReturnType<typeof CDP.List>>) {
  const active = activeMcpWindow()
  return selectWorkbenchTarget(allTargets, { projectPath: active ? active.projectPath : null })
}

/**
 * `selectSimulatorTarget` ranks candidates by a fixed priority order with no
 * idea which window each one belongs to, and its "any guest" tier in
 * particular has no way to tell a stray guest left over from another window
 * apart from a legitimate one.
 *
 * Once the active window has an `activeBridgeId` of its own, it is known to
 * be genuinely on a native page and merely waiting for that specific guest
 * target to show up in the CDP list — connecting to whatever guest IS present
 * and letting the post-connect ownership check below reject a wrong one is a
 * reasonable, existing way to close that timing gap, so ranking stays
 * unfiltered in that case.
 *
 * Before any page is known for this window (`activeBridgeId === null`, which
 * is also always true for non-native windows), though, "any guest present"
 * carries no signal it belongs to THIS window at all — so ranking is
 * restricted to targets `connectionOwner` attributes to the active window,
 * falling back to the raw list only when none of them qualify (the same
 * retry-and-reject cadence as the unfiltered path, for a candidate list that
 * belongs to no window MCP can currently claim).
 */
function findSimulatorTarget(allTargets: Awaited<ReturnType<typeof CDP.List>>) {
  const active = activeMcpWindow()
  const opts = { nativeHost: active?.nativeHost ?? false, activeBridgeId: active?.activeBridgeId ?? null }
  if (opts.activeBridgeId !== null) return selectSimulatorTarget(allTargets, opts)

  const intended = resolveActiveOwner()
  const owned = allTargets.filter((t) => connectionOwner('simulator', t.url, intended, windowFacts).onTarget)
  return selectSimulatorTarget(owned, opts) ?? selectSimulatorTarget(allTargets, opts)
}

function findTarget(allTargets: Awaited<ReturnType<typeof CDP.List>>, kind: TargetKind) {
  return kind === 'simulator' ? findSimulatorTarget(allTargets) : findWorkbenchTarget(allTargets)
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
  state.owner = null
  scheduleReconnect(kind)
}

/** Publish a connection that survived the race, on the window it reached. */
function publishConnection(kind: TargetKind, client: CDP.Client, owner: object | null): void {
  const state = targets[kind]
  state.client = client
  state.connected = true
  state.owner = owner
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

    // Which window this target belongs to is resolved here, not when the
    // attempt started: an attempt that outlived a window switch has to be
    // judged against the window the user is in now. MCP exposes ONE client per
    // kind, so a target belonging to another window leaves nothing behind at
    // all — buffers wired to it would mix that window's console and network
    // events into the ones the eventual right connection appends to, and
    // `connected` would hand it out meanwhile. The retry cadence is the only
    // thing that carries over: the exact target may still be loading.
    const binding = connectionOwner(kind, target.url, resolveActiveOwner(), windowFacts)
    if (!binding.onTarget) {
      await closeQuietly(client)
      if (superseded()) return
      loseTarget(kind)
      return
    }

    // Buffers are keyed to the owner they were collected for, not to the
    // kind slot: a reconnect landing on the SAME owner (a transient CDP drop)
    // must keep what was already buffered, but re-aiming at a different
    // window must not let that window inherit the previous owner's entries.
    if (state.bufferOwner !== binding.owner) {
      state.consoleLogs = []
      state.networkRequests = []
      state.bufferOwner = binding.owner
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

    publishConnection(kind, client, binding.owner)
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
  const label = kind === 'simulator' ? '模拟器' : '主窗口'
  if (!state.connected || !state.client) {
    throw new Error(`未连接到${label}。请确保 dimina-devtools 正在以开发模式运行。`)
  }
  // A focus change re-aims the live connections only once the burst settles,
  // and during that gap the client still belongs to the window the user left.
  // Answering from it would report and drive the wrong project, so the caller
  // waits for the re-aim instead.
  if (state.owner !== resolveActiveOwner()) {
    throw new Error(`${label}连接属于已切换的项目窗口，正在重新连接，请稍后重试。`)
  }
  return state.client
}
