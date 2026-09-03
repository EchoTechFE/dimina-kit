/**
 * MCP (Model Context Protocol) server entry point.
 *
 * The server speaks SSE over HTTP and exposes two sets of tools:
 *   - simulator_*   — reach into the in-app simulator webview via CDP
 *   - workbench_*    — reach into the workbench main renderer window via CDP
 *
 * See also:
 *   - `./server.ts`           HTTP/SSE transport + tool wiring
 *   - `./tool-registry.ts`    shared tool shapes (screenshot/console/eval/...)
 *   - `./tools/*-tools.ts`    kind-specific tools
 *   - `./target-manager.ts`   dual-target CDP connection + reconnect
 */

export { startMcpServer } from './server.js'
export { getMcpStatus, type McpRuntimeStatus } from './status.js'
// Every project window owns its own native-host state and its own renderer, so
// each registers its facts and MCP resolves the active window on every use.
export {
  registerMcpWindow,
  setActiveMcpWindowResolver,
  noteActiveBridgeId,
  noteActiveMcpWindowChanged,
  activeMcpWindow,
  getNativeOverviewProvider,
  type McpWindowFacts,
} from './target-manager.js'
export { createCloseForMcp, createOpenForMcp, type McpOpenedProject } from './opened-project.js'
