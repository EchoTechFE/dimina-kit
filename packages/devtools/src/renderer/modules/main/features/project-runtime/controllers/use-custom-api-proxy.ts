import { useEffect } from 'react'
import type { RefObject } from 'react'
import { invokeStrict as ipcInvokeStrict } from '@/shared/api/ipc-transport'
import {
  SimulatorCustomApiBridgeChannel,
  SimulatorCustomApiChannel,
} from '../../../../../../shared/ipc-channels'
import { ATTACH_RETRY_INTERVAL_MS, MAX_ATTACH_RETRIES } from '../../../../../../preload/shared/constants'
import { asWebview, type WebviewLike } from './webview-helpers'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UseCustomApiProxyProps {
  compileStatus: CompileStatus
  simulatorRef: RefObject<HTMLElement | null>
}

type BridgeRequest =
  | { id: number; op: 'list' }
  | { id: number; op: 'invoke'; name: string; params: unknown }

// Proxy custom-apis bridge calls from the simulator <webview> to the main
// process. The webview cannot reach ipcMain directly (sender-policy keeps it
// off the white-list), so its preload `__diminaCustomApis` sends a request
// via `ipcRenderer.sendToHost`; we forward to main, then post the result back
// through `<webview>.send`. Request/response are correlated by id in the
// webview's pending map, so concurrent invokes don't tangle.
export function useCustomApiProxy({ compileStatus, simulatorRef }: UseCustomApiProxyProps): void {
  useEffect(() => {
    if (compileStatus.status !== 'ready') return

    const handleRequest = async (webview: WebviewLike, req: BridgeRequest): Promise<void> => {
      let response: { id: number; result: unknown } | { id: number; error: string }
      try {
        const result = req.op === 'list'
          ? await ipcInvokeStrict<string[]>(SimulatorCustomApiChannel.List)
          : await ipcInvokeStrict<unknown>(SimulatorCustomApiChannel.Invoke, req.name, req.params)
        response = { id: req.id, result }
      } catch (err) {
        response = { id: req.id, error: err instanceof Error ? err.message : String(err) }
      }
      try {
        webview.send?.(SimulatorCustomApiBridgeChannel.Response, response)
      } catch {
        // webview may have detached between request and response; drop silently.
      }
    }

    const onIpcMessage = (event: Event): void => {
      const { channel, args } = event as Event & { channel: string; args: unknown[] }
      if (channel !== SimulatorCustomApiBridgeChannel.Request) return
      const req = args[0] as BridgeRequest | undefined
      if (!req || typeof req.id !== 'number') return
      const webview = asWebview(simulatorRef)
      if (!webview) return
      void handleRequest(webview, req)
    }

    // Same bounded attach loop as usePanelData — the <webview> mounts only
    // after preloadPath + simulatorUrl resolve, which can land after
    // compileStatus flips to 'ready'.
    let attached: WebviewLike | null = null
    let pollTimer: number | null = null
    let attempts = 0

    const tryAttach = (): void => {
      if (attached) return
      const webview = asWebview(simulatorRef)
      if (!webview) {
        attempts += 1
        if (attempts >= MAX_ATTACH_RETRIES && pollTimer !== null) {
          window.clearInterval(pollTimer)
          pollTimer = null
        }
        return
      }
      attached = webview
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      webview.addEventListener('ipc-message', onIpcMessage)
    }

    tryAttach()
    if (!attached) {
      pollTimer = window.setInterval(tryAttach, ATTACH_RETRY_INTERVAL_MS)
    }

    return () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      if (attached) {
        attached.removeEventListener('ipc-message', onIpcMessage)
      }
    }
  }, [compileStatus.status, simulatorRef])
}
