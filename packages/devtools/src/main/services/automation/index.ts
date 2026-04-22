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

import { ipcMain } from 'electron'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { AutomationChannel, SimulatorChannel } from '../../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../workbench-context.js'
import type { Handler, RpcEvent, RpcRequest, RpcResponse } from './shared.js'
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
let portIpcRegistered = false

export function getAutomationPort(): number | null {
  return currentPort
}

export async function startAutomationServer(
  ctx: WorkbenchContext,
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

  if (!portIpcRegistered) {
    portIpcRegistered = true
    ipcMain.handle(AutomationChannel.GetPort, () => currentPort)
  }

  function broadcast(event: RpcEvent): void {
    const msg = JSON.stringify(event)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  // Forward simulator console logs as App.logAdded events
  let consoleForwardingSetup = false
  function setupConsoleForwarding(): void {
    if (consoleForwardingSetup) return
    consoleForwardingSetup = true

    // Poll for simulator and set up listener
    const check = setInterval(() => {
      const sim = getSimulator(ctx)
      if (!sim) return
      clearInterval(check)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sim as any).on('ipc-message-host', (_event: unknown, channel: string, data: unknown) => {
        if (channel === SimulatorChannel.Console) {
          const logData = data as { level?: string; args?: unknown[] }
          broadcast({
            method: 'App.logAdded',
            params: { type: logData.level || 'log', args: logData.args || [] },
          })
        }
      })
    }, 1000)

    // Stop polling after 30s
    setTimeout(() => clearInterval(check), 30000)
  }

  wss.on('connection', (ws) => {
    clients.add(ws)
    setupConsoleForwarding()

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
          const result = await handler(ctx, params)
          response = { id, result }
        } catch (err) {
          response = { id, error: { message: (err as Error).message || String(err) } }
        }
      }

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response))
    })

    ws.on('close', () => clients.delete(ws))
  })

  return {
    close: () => {
      if (currentPort === resolvedPort) currentPort = null
      wss.close()
    },
    port: resolvedPort,
  }
}
