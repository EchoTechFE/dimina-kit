import {
  ipcMain,
  type IpcMainEvent,
} from 'electron'
import {
  isMainFrameIpcSender,
  type Disposable,
  type IpcSenderPolicy,
} from '@dimina-kit/electron-deck/main'

export type SenderPolicy = IpcSenderPolicy
type HandleFn = Parameters<typeof ipcMain.handle>[1]
type ListenerFn = Parameters<typeof ipcMain.on>[1]

/** Small sender-gated IPC owner used by runtime-only services. */
export class RuntimeIpcRegistry implements Disposable {
  private cleanups: Array<() => void> = []
  private disposed = false

  constructor(private readonly policy: SenderPolicy) {}

  handle(channel: string, fn: HandleFn): this {
    const guarded: HandleFn = async (event, ...args) => {
      if (!this.policy(event.sender) || !isMainFrameIpcSender(event)) {
        throw new Error(`IPC sender rejected for channel ${channel}`)
      }
      return fn(event, ...args)
    }
    try {
      ipcMain.handle(channel, guarded)
    } catch (error) {
      this.dispose()
      throw error
    }
    this.cleanups.push(() => ipcMain.removeHandler(channel))
    return this
  }

  on(channel: string, fn: ListenerFn): this {
    const raw = fn as (event: IpcMainEvent, ...args: unknown[]) => unknown
    const guarded: ListenerFn = (event, ...args) => {
      if (!this.policy(event.sender) || !isMainFrameIpcSender(event)) return
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
    try {
      ipcMain.on(channel, guarded)
    } catch (error) {
      this.dispose()
      throw error
    }
    this.cleanups.push(() => ipcMain.removeListener(channel, guarded))
    return this
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
  }
}
