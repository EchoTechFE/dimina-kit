import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'
import { DisposableRegistry, type Disposable } from './disposable.js'
import { IpcValidationError } from './ipc-schema.js'
import { createLogger } from './logger.js'

type HandleFn = Parameters<typeof ipcMain.handle>[1]
type ListenerFn = Parameters<typeof ipcMain.on>[1]

const log = createLogger('ipc')

/**
 * Funnels errors thrown by an `on()` listener into the logger so they don't
 * escape into Electron's event loop. Validation errors get a compact `warn`
 * (channel + zod paths), other errors get a full `error` with stack.
 */
function reportListenerError(channel: string, err: unknown): void {
  if (err instanceof IpcValidationError) {
    log.warn(`schema reject on '${channel}' at [${err.paths.join(', ')}]`)
    return
  }
  if (err instanceof Error) {
    log.error(`listener threw on '${channel}': ${err.message}`, err.stack)
    return
  }
  log.error(`listener threw on '${channel}'`, err)
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v != null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}

/**
 * Trust predicate used to gate IPC delivery on the main process.
 *
 * Returns true when the calling WebContents is allowed to invoke / emit on
 * the channel, false otherwise.
 */
export type SenderPolicy = (sender: WebContents) => boolean

function summarizeSender(sender: WebContents): string {
  if (sender.isDestroyed()) return '<destroyed>'
  const url = sender.getURL()
  return `id=${sender.id} ${url.slice(0, 120)}`
}

/**
 * Tiny fluent helper that wraps every `ipcMain.handle` / `ipcMain.on` with a
 * matching removeHandler/removeListener registered into an internal registry.
 *
 * Each `register*Ipc(ctx)` returns one of these as a Disposable so the
 * workbench-level registry can dispose all built-in handlers in one shot.
 *
 * If a {@link SenderPolicy} is provided, every incoming invocation is gated:
 * - `handle`: rejected senders cause the invoke promise to reject with
 *   `Error('IPC sender rejected for channel <channel>')`.
 * - `on`: rejected senders are silently dropped (the original listener is
 *   never called).
 * In both cases a single `console.warn` is emitted with the channel name
 * and a short sender summary. Without a policy the wrapper is a no-op,
 * preserving backwards compatibility for unit tests and callers that
 * opted out.
 */
export class IpcRegistry implements Disposable {
  private registry = new DisposableRegistry()

  constructor(private policy?: SenderPolicy) {}

  handle(channel: string, fn: HandleFn): this {
    const policy = this.policy
    const guarded: HandleFn = policy
      ? (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          const sender = event.sender
          if (!policy(sender)) {
            console.warn(
              `[ipc] sender rejected for channel '${channel}' (${summarizeSender(sender)})`,
            )
            throw new Error(`IPC sender rejected for channel ${channel}`)
          }
          return (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(event, ...args)
        }
      : fn
    ipcMain.handle(channel, guarded)
    this.registry.add(() => ipcMain.removeHandler(channel))
    return this
  }

  on(channel: string, fn: ListenerFn): this {
    const policy = this.policy
    const raw = fn as (e: IpcMainEvent, ...a: unknown[]) => unknown
    const safeInvoke = (event: IpcMainEvent, args: unknown[]) => {
      try {
        const ret = raw(event, ...args)
        if (isThenable(ret)) {
          // Async listeners would otherwise leak rejections into Electron's
          // event loop as `UnhandledPromiseRejection`. Funnel them into the
          // same logger path as sync throws.
          Promise.resolve(ret).catch((err) => reportListenerError(channel, err))
        }
      } catch (err) {
        reportListenerError(channel, err)
      }
    }
    const guarded: ListenerFn = policy
      ? (event: IpcMainEvent, ...args: unknown[]) => {
          const sender = event.sender
          if (!policy(sender)) {
            console.warn(
              `[ipc] sender rejected for channel '${channel}' (${summarizeSender(sender)})`,
            )
            return
          }
          safeInvoke(event, args)
        }
      : (event: IpcMainEvent, ...args: unknown[]) => safeInvoke(event, args)
    ipcMain.on(channel, guarded)
    this.registry.add(() => {
      ipcMain.removeListener(channel, guarded)
    })
    return this
  }

  dispose(): Promise<void> {
    return this.registry.dispose()
  }
}
