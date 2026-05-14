/**
 * HTTP + SSE server entry for the MCP transport.
 *
 * Exposes an HTTP/SSE endpoint (`/sse` for the stream, `/message` for
 * outbound JSON-RPC messages) that the Model Context Protocol SDK drives.
 * Tool registration lives in `./tool-registry` and `./tools/*`; this file
 * only wires up transports and lifecycle.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer } from 'http'
import { createRequire } from 'node:module'
import { toDisposable, type Disposable } from '../../utils/disposable.js'
import { connectTarget, setCdpPort } from './target-manager.js'
import { registerCommonTargetTools } from './tool-registry.js'
import { registerContextTools } from './tools/context-tools.js'
import { registerSimulatorTools } from './tools/simulator-tools.js'
import { registerWorkbenchTools } from './tools/workbench-tools.js'

const require = createRequire(import.meta.url)
const pkg = require('../../../../package.json') as { version: string }

function buildServer(): McpServer {
  const server = new McpServer({
    name: '@dimina-kit/devtools',
    version: pkg.version,
  })

  // Simulator tools: shared target ops + simulator-specific
  registerCommonTargetTools(server, 'simulator')
  registerSimulatorTools(server)

  // Workbench main-window tools: shared target ops + workbench-specific
  registerCommonTargetTools(server, 'workbench')
  registerWorkbenchTools(server)

  // Cross-target: AI orientation overview
  registerContextTools(server)

  return server
}

export function startMcpServer(resolvedCdpPort: number, mcpPort: number): Disposable {
  setCdpPort(resolvedCdpPort)

  // Connect to both targets (non-blocking)
  connectTarget('simulator').catch(() => {})
  connectTarget('workbench').catch(() => {})

  const server = buildServer()
  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/message', res)
      transports.set(transport.sessionId, transport)
      res.on('close', () => transports.delete(transport.sessionId))
      await server.connect(transport)
    } else if (req.method === 'POST' && url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const transport = transports.get(sessionId)
      if (transport) {
        await transport.handlePostMessage(req, res)
      } else {
        res.writeHead(404).end()
      }
    } else {
      res.writeHead(404).end()
    }
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[MCP] Port ${mcpPort} already in use — MCP server not started`)
    } else {
      console.error('[MCP] Server error:', err)
    }
  })

  httpServer.listen(mcpPort, '127.0.0.1', () => {
    console.log(`[MCP] SSE server listening on http://127.0.0.1:${mcpPort}/sse`)
  })

  return toDisposable(() => {
    transports.clear()
    httpServer.close()
  })
}
