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
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { connectTarget, setCdpPort } from './target-manager.js'
import { recordMcpFailed, recordMcpStarted, recordMcpStopped } from './status.js'
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

  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/message', res)
      transports.set(transport.sessionId, transport)
      res.on('close', () => transports.delete(transport.sessionId))
      try {
        // A fresh McpServer PER CONNECTION: the SDK's Protocol is strictly
        // 1:1 with its transport (`connect()` throws "Already connected to a
        // transport" if `this._transport` is already set), so reusing one
        // global server across concurrent SSE clients breaks every
        // connection after the first. Registration only builds tool-call
        // closures over already-shared module-level state (target-manager's
        // CDP connections/listeners) — it has no per-call side effects, so
        // building N servers is cheap and duplicates nothing.
        await buildServer().connect(transport)
      } catch (err) {
        transports.delete(transport.sessionId)
        // `connect()` calls `transport.start()` (writes the SSE 200 + headers)
        // BEFORE it can throw, so a post-start failure here has already sent
        // headers — writeHead would itself throw. End the response instead so
        // the client's stream closes cleanly rather than hanging forever with
        // an open connection nothing will ever write to again.
        if (!res.headersSent) res.writeHead(500).end('MCP connect failed')
        else res.end()
        console.error('[MCP] SSE connect failed:', err)
      }
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
      recordMcpFailed('port-in-use')
    } else {
      console.error('[MCP] Server error:', err)
      recordMcpFailed(err.message)
    }
  })

  httpServer.listen(mcpPort, '127.0.0.1', () => {
    console.log(`[MCP] SSE server listening on http://127.0.0.1:${mcpPort}/sse`)
    recordMcpStarted(mcpPort)
  })

  return toDisposable(() => {
    transports.clear()
    httpServer.close()
    recordMcpStopped()
  })
}
