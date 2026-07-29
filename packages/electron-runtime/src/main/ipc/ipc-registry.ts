import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import type { Disposable } from '@dimina-kit/electron-deck/main'

export type SenderPolicy = (sender: WebContents) => boolean
type HandleFn = Parameters<typeof ipcMain.handle>[1]
type ListenerFn = Parameters<typeof ipcMain.on>[1]
type FrameRef = { routingId: number; processId: number } | null | undefined

function isMainFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = (event as { senderFrame?: FrameRef }).senderFrame
  const main = (event.sender as { mainFrame?: FrameRef }).mainFrame
  if (frame === undefined && main === undefined) return true
  if (frame == null || main == null) return false
  return frame.routingId === main.routingId && frame.processId === main.processId
}

/** Small sender-gated IPC owner used by runtime-only services. */
export class RuntimeIpcRegistry implements Disposable {
  private cleanups: Array<() => void> = []
  private disposed = false

  constructor(private readonly policy: SenderPolicy) {}

  handle(channel: string, fn: HandleFn): this {
    const guarded: HandleFn = async (event, ...args) => {
      if (!this.policy(event.sender) || !isMainFrame(event)) {
        throw new Error(`IPC sender rejected for channel ${channel}`)
      }
      return fn(event, ...args)
    }
    ipcMain.handle(channel, guarded)
    this.cleanups.push(() => ipcMain.removeHandler(channel))
    return this
  }

  on(channel: string, fn: ListenerFn): this {
    const raw = fn as (event: IpcMainEvent, ...args: unknown[]) => unknown
    const guarded: ListenerFn = (event, ...args) => {
      if (!this.policy(event.sender) || !isMainFrame(event)) return
      try {
        const result = raw(event, ...args)
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch((error) => {
            console.error(`[electron-runtime] IPC listener '${channel}' failed`, error)
          })
        }
      } catch (error) {
        console.error(`[electron-runtime] IPC listener '${channel}' failed`, error)
      }
    }
    ipcMain.on(channel, guarded)
    this.cleanups.push(() => ipcMain.removeListener(channel, guarded))
    return this
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
  }
}
