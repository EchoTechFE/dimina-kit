/**
 * Workbench-specific MCP tools. Exposes CDP target listing, which cannot be
 * expressed as a plain evaluate against a connected target.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listTargets } from '../target-manager.js'

export function registerWorkbenchTools(server: McpServer): void {
  server.tool('workbench_list_targets', 'List all available CDP targets (pages, webviews, etc.)', {}, async () => {
    const allTargets = await listTargets()
    const summary = allTargets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }))
    return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] }
  })
}
