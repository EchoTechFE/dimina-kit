/**
 * One-shot MCP orientation tools.
 *
 * `simulator_get_overview` / `workbench_get_overview` return a single compact
 * JSON snapshot so AI clients can orient themselves at session start without
 * issuing many separate probe calls (page info, storage, console, network).
 *
 * Registered as tools rather than MCP resources: the payload is highly
 * dynamic (CDP state + rolling buffers), current clients invoke tools more
 * reliably than they read resources, and this keeps the surface consistent
 * with sibling `*_get_page_info` / `*_connection_status` tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient, getTargetState, type TargetKind } from '../target-manager.js'

// Truncation thresholds: keep the overview compact — orientation, not data dump.
const MAX_KEYS = 50
const MAX_HINT_TEXT = 200

interface SimulatorProbe {
  url: string
  title: string
  viewport: { width: number; height: number } | null
  currentRoute: string | null
  pageStackDepth: number
  storageKeys: string[]
  storageCount: number
  appDataKeys: string[]
  bridgeReady: boolean
  simulatorDataPresent: boolean
}

// Evaluated inside the simulator webview. Tolerates missing __simulatorData.
const SIMULATOR_PROBE_EXPR = `(() => {
  const out = {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    currentRoute: null,
    pageStackDepth: 0,
    storageKeys: [],
    storageCount: 0,
    appDataKeys: [],
    bridgeReady: false,
    simulatorDataPresent: false,
  };
  try {
    const frames = document.querySelectorAll('.dimina-native-webview__window');
    out.pageStackDepth = frames.length;
    const active = frames[frames.length - 1];
    if (active) {
      out.currentRoute = active.getAttribute('data-route')
        || active.getAttribute('src')
        || active.getAttribute('data-path')
        || null;
    }
  } catch (e) {}
  try {
    const bridge = window.__simulatorData;
    if (bridge) {
      out.simulatorDataPresent = true;
      if (typeof bridge.getStorageSnapshot === 'function') {
        const snap = bridge.getStorageSnapshot();
        out.bridgeReady = !!(snap && snap.ready);
        const data = (snap && snap.data) || {};
        out.storageKeys = Object.keys(data).slice(0, ${MAX_KEYS});
        out.storageCount = Object.keys(data).length;
      }
      if (typeof bridge.getAppdata === 'function') {
        const app = bridge.getAppdata() || {};
        out.appDataKeys = Object.keys(app).slice(0, ${MAX_KEYS});
      }
    }
  } catch (e) {}
  return JSON.stringify(out);
})()`

const WORKBENCH_PROBE_EXPR = `(() => JSON.stringify({
  url: location.href,
  title: document.title,
  viewport: { width: window.innerWidth, height: window.innerHeight },
}))()`

interface ConsoleSummary {
  total: number
  recentErrorCount: number
  recentWarningCount: number
  lastError: { level: string; text: string; timestamp: string } | null
}

interface NetworkSummary {
  total: number
  recentNetworkErrorCount: number
  lastNetworkError: { url: string; status: number; method: string } | null
}

function summarizeConsole(kind: TargetKind): ConsoleSummary {
  const logs = getTargetState(kind).consoleLogs
  let recentErrorCount = 0
  let recentWarningCount = 0
  let lastError: ConsoleSummary['lastError'] = null
  for (const entry of logs) {
    if (entry.level === 'error') {
      recentErrorCount++
      lastError = { level: entry.level, text: entry.text.slice(0, MAX_HINT_TEXT), timestamp: entry.timestamp }
    } else if (entry.level === 'warning' || entry.level === 'warn') {
      recentWarningCount++
    }
  }
  return { total: logs.length, recentErrorCount, recentWarningCount, lastError }
}

function summarizeNetwork(kind: TargetKind): NetworkSummary {
  const reqs = getTargetState(kind).networkRequests
  let recentNetworkErrorCount = 0
  let lastNetworkError: NetworkSummary['lastNetworkError'] = null
  for (const r of reqs) {
    if (r.status >= 400 || r.status === 0) {
      recentNetworkErrorCount++
      lastNetworkError = { url: r.url, status: r.status, method: r.method }
    }
  }
  return { total: reqs.length, recentNetworkErrorCount, lastNetworkError }
}

function buildDisconnectedOverview(kind: TargetKind, hints: string[]) {
  if (kind === 'simulator') {
    return {
      connected: false,
      url: '',
      title: '',
      viewport: null,
      currentRoute: null,
      pageStackDepth: 0,
      storageKeys: [],
      storageCount: 0,
      appDataKeys: [],
      recentErrorCount: 0,
      lastError: null,
      recentWarningCount: 0,
      recentNetworkErrorCount: 0,
      lastNetworkError: null,
      consoleLogTotal: 0,
      networkRequestTotal: 0,
      hints,
    }
  }

  return {
    connected: false,
    url: '',
    title: '',
    viewport: null,
    recentErrorCount: 0,
    lastError: null,
    recentNetworkErrorCount: 0,
    lastNetworkError: null,
    consoleLogTotal: 0,
    networkRequestTotal: 0,
    hints,
  }
}

export function registerContextTools(server: McpServer): void {
  server.tool(
    'simulator_get_overview',
    'One-shot orientation snapshot of the simulator (page, storage keys, appdata keys, recent errors). Call at session start to avoid many probe queries.',
    {},
    async () => {
      const state = getTargetState('simulator')
      const hints: string[] = []

      if (!state.connected || !state.client) {
        const payload = buildDisconnectedOverview('simulator', ['simulator not connected — ensure dimina-devtools is running in dev mode'])
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }

      let result
      try {
        const c = getClient('simulator')
        result = await c.Runtime.evaluate({ expression: SIMULATOR_PROBE_EXPR, returnByValue: true })
      } catch {
        const payload = buildDisconnectedOverview('simulator', [...hints, 'simulator disconnected before overview could finish'])
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }
      if (result.exceptionDetails) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.exceptionDetails.text}` }],
          isError: true,
        }
      }

      let probe: SimulatorProbe
      try {
        probe = JSON.parse(result.result.value)
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: probe returned non-JSON payload' }],
          isError: true,
        }
      }

      if (!probe.simulatorDataPresent) hints.push('simulator bridge not ready (window.__simulatorData missing)')
      else if (!probe.bridgeReady) hints.push('simulator bridge present but storage snapshot not ready')
      if (probe.pageStackDepth === 0) hints.push('no active miniapp page (empty page stack)')
      if (probe.storageCount > MAX_KEYS) hints.push(`storageKeys truncated to first ${MAX_KEYS} of ${probe.storageCount}`)

      const consoleSum = summarizeConsole('simulator')
      const networkSum = summarizeNetwork('simulator')

      const payload = {
        connected: true,
        url: probe.url,
        title: probe.title,
        viewport: probe.viewport,
        currentRoute: probe.currentRoute,
        pageStackDepth: probe.pageStackDepth,
        storageKeys: probe.storageKeys,
        storageCount: probe.storageCount,
        appDataKeys: probe.appDataKeys,
        recentErrorCount: consoleSum.recentErrorCount,
        lastError: consoleSum.lastError,
        recentWarningCount: consoleSum.recentWarningCount,
        recentNetworkErrorCount: networkSum.recentNetworkErrorCount,
        lastNetworkError: networkSum.lastNetworkError,
        consoleLogTotal: consoleSum.total,
        networkRequestTotal: networkSum.total,
        hints,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
    },
  )

  server.tool(
    'workbench_get_overview',
    'One-shot orientation snapshot of the workbench main window (url, title, viewport, recent errors, totals).',
    {},
    async () => {
      const state = getTargetState('workbench')
      const hints: string[] = []

      if (!state.connected || !state.client) {
        const payload = buildDisconnectedOverview('workbench', ['workbench not connected — ensure dimina-devtools is running in dev mode'])
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }

      let result
      try {
        const c = getClient('workbench')
        result = await c.Runtime.evaluate({ expression: WORKBENCH_PROBE_EXPR, returnByValue: true })
      } catch {
        const payload = buildDisconnectedOverview('workbench', [...hints, 'workbench disconnected before overview could finish'])
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }
      if (result.exceptionDetails) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.exceptionDetails.text}` }],
          isError: true,
        }
      }

      let probe: { url: string; title: string; viewport: { width: number; height: number } | null }
      try {
        probe = JSON.parse(result.result.value)
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: probe returned non-JSON payload' }],
          isError: true,
        }
      }

      const consoleSum = summarizeConsole('workbench')
      const networkSum = summarizeNetwork('workbench')

      const payload = {
        connected: true,
        url: probe.url,
        title: probe.title,
        viewport: probe.viewport,
        recentErrorCount: consoleSum.recentErrorCount,
        lastError: consoleSum.lastError,
        recentNetworkErrorCount: networkSum.recentNetworkErrorCount,
        lastNetworkError: networkSum.lastNetworkError,
        consoleLogTotal: consoleSum.total,
        networkRequestTotal: networkSum.total,
        hints,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
    },
  )
}
