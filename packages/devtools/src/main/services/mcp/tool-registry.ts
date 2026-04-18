/**
 * Registration helpers for the 5 MCP tools that exist symmetrically for both
 * simulator and workbench targets (screenshot / console_logs / evaluate /
 * get_dom / network_log). Wiring the shared set here keeps the handler
 * definitions in one place while still allowing kind-specific descriptions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getClient, getTargetState, type TargetKind } from './target-manager.js'

/**
 * Registers the 5 tools that exist symmetrically for both targets.
 * Each tool name is prefixed with the kind (e.g. `simulator_screenshot`).
 */
export function registerCommonTargetTools(server: McpServer, kind: TargetKind): void {
  const descriptions = kind === 'simulator'
    ? {
        screenshot: 'Take a screenshot of the simulator webview',
        consoleLogs: 'Get recent console output from the simulator (supports level/sinceTimestamp filters)',
        evaluate: 'Execute JavaScript in the simulator context',
        getDom: 'Get the DOM tree of the simulator page',
        networkLog: 'Get recent network requests from the simulator (supports minStatus filter)',
      }
    : {
        screenshot: 'Take a screenshot of the workbench main window',
        consoleLogs: 'Get recent console output from the workbench main window (supports level/sinceTimestamp filters; warn/warning are treated as aliases)',
        evaluate: 'Execute JavaScript in the workbench main window renderer',
        getDom: 'Get the DOM tree of the workbench main window',
        networkLog: 'Get recent network requests from the workbench main window (supports minStatus filter)',
      }

  server.tool(`${kind}_screenshot`, descriptions.screenshot, {}, async () => {
    const c = getClient(kind)
    const { data } = await c.Page.captureScreenshot({ format: 'png' })
    return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
  })

  server.tool(`${kind}_console_logs`, descriptions.consoleLogs, {
    limit: z.number().optional().default(50).describe('Maximum number of log entries'),
    level: z.enum(['error', 'warning', 'warn', 'info', 'log', 'debug']).optional().describe('Only return entries with this level'),
    sinceTimestamp: z.string().optional().describe('ISO timestamp; only return entries at or after this time'),
  }, async ({ limit, level, sinceTimestamp }) => {
    getClient(kind)
    let entries = getTargetState(kind).consoleLogs
    if (level) {
      // Runtime.consoleAPICalled uses 'warning'; Console.messageAdded may emit 'warn'
      const levels = level === 'warning' || level === 'warn' ? ['warning', 'warn'] : [level]
      entries = entries.filter((e) => levels.includes(e.level))
    }
    if (sinceTimestamp) {
      entries = entries.filter((e) => e.timestamp >= sinceTimestamp)
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(entries.slice(-limit), null, 2) }] }
  })

  // workbench has nodeIntegration; evaluate would equal arbitrary local code execution
  if (kind !== 'workbench') {
    server.tool(`${kind}_evaluate`, descriptions.evaluate, {
      expression: z.string().describe('JavaScript expression to evaluate'),
    }, async ({ expression }) => {
      const c = getClient(kind)
      const result = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.exceptionDetails.text}\n${JSON.stringify(result.exceptionDetails, null, 2)}` }], isError: true }
      }
      const value = result.result.value !== undefined ? result.result.value : result.result.description || result.result.type
      return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
    })
  }

  server.tool(`${kind}_get_dom`, descriptions.getDom, {
    depth: z.number().optional().default(3).describe('Maximum depth'),
  }, async ({ depth }) => {
    const c = getClient(kind)
    const { root } = await c.DOM.getDocument({ depth })
    return { content: [{ type: 'text' as const, text: JSON.stringify(root, null, 2) }] }
  })

  server.tool(`${kind}_network_log`, descriptions.networkLog, {
    limit: z.number().optional().default(20).describe('Maximum number of entries'),
    minStatus: z.number().optional().describe('Only return entries with status >= minStatus (status 0 = failed before response is included when minStatus >= 400)'),
  }, async ({ limit, minStatus }) => {
    getClient(kind)
    let entries = getTargetState(kind).networkRequests
    if (minStatus !== undefined) {
      entries = entries.filter((e) => e.status >= minStatus || (e.status === 0 && minStatus >= 400))
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(entries.slice(-limit), null, 2) }] }
  })
}
