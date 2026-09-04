/**
 * WebSocket automation server compatible with miniprogram-automator protocol.
 *
 * miniprogram-automator sends JSON-RPC messages over WebSocket:
 *   Request:  { id: "uuid", method: "App.getCurrentPage", params: {} }
 *   Response: { id: "uuid", result: {...} }  or  { id: "uuid", error: { message: "..." } }
 *   Event:    { method: "App.logAdded", params: {...} }
 *
 * This server handles these messages by delegating to the workbench context
 * (simulator webContents, IPC handlers, etc.) without modifying dimina upstream.
 */

import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { AutomationChannel } from '../../../shared/ipc-channels.js'
import { IpcRegistry } from '../../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../../utils/ipc-context-source.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../workbench-context.js'
import type { Handler, RpcEvent, RpcRequest, RpcResponse } from './shared.js'
import { createConnectionTarget } from './connection-target.js'
import { createConsoleBridge, type ConsoleBridge } from './console-bridge.js'
import { getSimulator } from './exec.js'
import { toolHandlers } from './handlers/tool.js'
import { appHandlers } from './handlers/app.js'
import { pageHandlers } from './handlers/page.js'
import { elementHandlers } from './handlers/element.js'

// ── Protocol Handlers ─────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  ...toolHandlers,
  ...appHandlers,
  ...pageHandlers,
  ...elementHandlers,
}

// ── Server ────────────────────────────────────────────────────────────

export interface AutomationServer {
  close: () => void
  port: number
}

let currentPort: number | null = null

export function getAutomationPort(): number | null {
  return currentPort
}

/**
 * `getCtx` rather than a context: the server binds its port at boot, before any
 * project window exists, so there is nothing to capture yet. Each connection
 * then pins the first project window it reaches and keeps driving that one —
 * `getCtx` is how it finds that window, not a per-message lookup.
 *
 * `senders` covers every live window instead, because the port channel is asked
 * by renderers `getCtx` never names: the project list and background project
 * windows all start automation clients of their own.
 */
export async function startAutomationServer(
  getCtx: () => WorkbenchContext,
  senders: IpcInput<WorkbenchContext>,
  port: number = 0,
): Promise<AutomationServer> {
  const wss = new WebSocketServer({ port })
  const clients = new Set<WebSocket>()

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', (err) => reject(err))
  })

  const addr = wss.address()
  // ws always binds via an http.Server, so address() is AddressInfo here.
  const resolvedPort = typeof addr === 'object' && addr ? (addr as AddressInfo).port : port
  currentPort = resolvedPort

  // Gated per OWNING window: each window trusts its own renderer plus its
  // settings/popover overlays (see createWorkbenchSenderPolicy), and the
  // simulator webview is trusted by none of them. Gating on the active
  // window's policy instead would reject every window that does not currently
  // have focus, starting with the project list.
  const portIpc = new IpcRegistry(toIpcContextSource(senders))
  portIpc.handle(AutomationChannel.GetPort, () => {
    return currentPort
  })

  // Every connection owns its console bridge, because every connection has its
  // own target window: a single server-wide broadcast would hand one client the
  // logs of a project another client is driving.
  const bridges = new Set<ConsoleBridge>()

  wss.on('connection', (ws) => {
    clients.add(ws)

    const send = (msg: RpcEvent | RpcResponse): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    }
    // Pinned, not resolved per message: the window a script drives is settled by
    // the first project window this connection reaches, so a user clicking
    // another project's window can't redirect it (see `createConnectionTarget`).
    const target = createConnectionTarget(getCtx)
    const consoleBridge = createConsoleBridge(() => target.peek(), getSimulator, send)
    bridges.add(consoleBridge)
    // Before any message: a client that only listens for `App.logAdded` never
    // sends one, and still has to receive its target window's console.
    consoleBridge.sync()

    ws.on('message', async (raw) => {
      let req: RpcRequest
      try {
        req = JSON.parse(String(raw)) as RpcRequest
      } catch { return }

      const { id, method, params = {} } = req
      const handler = handlers[method]

      let response: RpcResponse
      if (!handler) {
        response = { id, error: { message: `Unknown method: ${method}` } }
      } else {
        try {
          // Same target for the command and for the logs it produces.
          const ctx = target.resolve()
          consoleBridge.sync()
          const result = await handler(ctx, params)
          response = { id, result }
        } catch (err) {
          response = { id, error: { message: (err as Error).message || String(err) } }
        }
      }

      send(response)
    })

    ws.on('close', () => {
      clients.delete(ws)
      bridges.delete(consoleBridge)
      consoleBridge.dispose()
    })
  })

  return {
    close: () => {
      // Detaches every connection's simulator listener and unsubscribes it from
      // its window's ConsoleForwarder, so a late guest console entry can't fire
      // against a torn-down server. The forwarder keeps owning `ctx.guestConsole`
      // (render→service mirroring continues without an automation client).
      for (const bridge of bridges) bridge.dispose()
      bridges.clear()
      for (const ws of clients) {
        try { ws.close() } catch { /* noop */ }
      }
      clients.clear()
      if (currentPort === resolvedPort) currentPort = null
      void portIpc.dispose()
      wss.close()
    },
    port: resolvedPort,
  }
}
