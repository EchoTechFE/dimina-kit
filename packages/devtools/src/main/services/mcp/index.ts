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
// Native-host: let app.ts point the `simulator` CDP target at the active
// render-host guest as the visible page changes.
export {
  setNativeHost,
  setActiveBridgeId,
  setNativeOverviewProvider,
  getNativeOverviewProvider,
} from './target-manager.js'
