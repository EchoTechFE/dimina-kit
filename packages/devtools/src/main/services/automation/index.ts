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

import type { WebContents } from 'electron'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { AutomationChannel, SimulatorChannel } from '../../../shared/ipc-channels.js'
import { IpcRegistry } from '../../utils/ipc-registry.js'
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

  // Gate AutomationChannel.GetPort with the workbench sender policy (only
  // the main renderer + workbench settings/popover overlays are allowed to
  // read the port — see createWorkbenchSenderPolicy; the simulator webview
  // is intentionally NOT trusted for IPC invokes).
  const portIpc = new IpcRegistry(ctx.senderPolicy)
  portIpc.handle(AutomationChannel.GetPort, () => {
    return currentPort
  })

  function broadcast(event: RpcEvent): void {
    const msg = JSON.stringify(event)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  // Forward simulator console logs as App.logAdded events.
  // Track the polling interval + stop timer + currently-attached sim and
  // the named handler so we can fully detach on close() or sim destruction.
  // Without this the listener accumulates across create/dispose cycles and
  // across simulator rebuilds.
  let consoleForwardingSetup = false
  let pollInterval: ReturnType<typeof setInterval> | null = null
  let pollStopTimer: ReturnType<typeof setTimeout> | null = null
  let attachedSim: WebContents | null = null
  let ipcMessageHostHandler: ((event: unknown, channel: string, data: unknown) => void) | null = null
  let simDestroyedHandler: (() => void) | null = null

  function detachConsoleForwarding(): void {
    if (attachedSim) {
      if (ipcMessageHostHandler) {
        try {
          if (!attachedSim.isDestroyed()) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(attachedSim as any).removeListener('ipc-message-host', ipcMessageHostHandler)
          }
        } catch { /* noop */ }
      }
      if (simDestroyedHandler) {
        try {
          if (!attachedSim.isDestroyed()) {
            attachedSim.removeListener('destroyed', simDestroyedHandler)
          }
        } catch { /* noop */ }
      }
    }
    attachedSim = null
    ipcMessageHostHandler = null
    simDestroyedHandler = null
  }

  function setupConsoleForwarding(): void {
    if (consoleForwardingSetup) return
    consoleForwardingSetup = true

    pollInterval = setInterval(() => {
      const sim = getSimulator(ctx)
      if (!sim) return
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }

      const onIpcMessageHost = (_event: unknown, channel: string, data: unknown): void => {
        if (channel === SimulatorChannel.Console) {
          const logData = data as { level?: string; args?: unknown[] }
          broadcast({
            method: 'App.logAdded',
            params: { type: logData.level || 'log', args: logData.args || [] },
          })
        }
      }
      const onSimDestroyed = (): void => {
        // Sim webContents is dead — drop refs (removeListener on a destroyed
        // sender would throw) and allow re-attach to a new simulator.
        attachedSim = null
        ipcMessageHostHandler = null
        simDestroyedHandler = null
        consoleForwardingSetup = false
      }

      attachedSim = sim
      ipcMessageHostHandler = onIpcMessageHost
      simDestroyedHandler = onSimDestroyed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sim as any).on('ipc-message-host', onIpcMessageHost)
      sim.once('destroyed', onSimDestroyed)
    }, 1000)

    // Stop polling after 30s
    pollStopTimer = setTimeout(() => {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      pollStopTimer = null
    }, 30000)
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
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      if (pollStopTimer) {
        clearTimeout(pollStopTimer)
        pollStopTimer = null
      }
      detachConsoleForwarding()
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
