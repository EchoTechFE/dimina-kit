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
 * Defense-in-depth frame check (sits alongside the sender white-list). A trusted
 * webContents could embed a sub-frame of arbitrary origin; only its top (main)
 * frame should reach gated IPC, so a sub-frame can't spoof the trusted sender.
 *
 * Verified on Electron 41 that `event.senderFrame` is reliably present on
 * invoke / send / sendSync — including the editor's `beforeunload` sendSync
 * write — and equals `sender.mainFrame` for top-frame traffic, so this never
 * mis-rejects legitimate callers.
 *
 * Fail-closed on a null frame for REAL events: a sub-frame can send a message
 * and immediately navigate/destroy itself, so by delivery time `senderFrame`
 * resolves to null — allowing that would let the navigate-after-send trick
 * bypass the boundary. A real Electron event always exposes the `senderFrame`
 * property and `sender.mainFrame`, so we can tell a real event (frame-modeled,
 * possibly null) from a frame-unaware unit-test stub (neither present) and only
 * skip the check for the latter (the sender-id white-list still gates tests).
 */
type FrameRef = { routingId: number; processId: number } | null | undefined
function isMainFrameSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  // Read via loose casts: the Electron types declare these always-present, but
  // unit-test stubs legitimately omit them — and real events can carry a null
  // senderFrame after navigation/destruction.
  const frame = (event as { senderFrame?: FrameRef }).senderFrame
  const main = (event.sender as { mainFrame?: FrameRef }).mainFrame
  // Frame-unaware stub (NEITHER field modeled) → not a real frame boundary; the
  // sender-id white-list is the gate. Real events always have both, so they fall
  // through to the strict check; a partial/malformed event (only one field) also
  // falls through and fail-closes below rather than escaping here.
  if (frame === undefined && main === undefined) return true
  // Real event, unresolvable frame (navigate-after-send / destroyed) → reject.
  if (frame == null || main == null) return false
  return frame.routingId === main.routingId && frame.processId === main.processId
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
    // The gate is `async` so a rejected sender surfaces as a *rejected
    // promise* (the invoke-result contract) rather than a synchronous throw —
    // synchronous throws can escape callers that wrap the result in
    // `Promise.resolve(...)` instead of `await`-ing it directly.
    const guarded: HandleFn = policy
      ? async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          const sender = event.sender
          if (!policy(sender) || !isMainFrameSender(event)) {
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

  /**
   * Register a SYNCHRONOUS `ipcRenderer.sendSync` handler. Unlike {@link on}
   * (fire-and-forget), the renderer is blocked until we set `event.returnValue`,
   * so `fn` MUST be synchronous and return the value to hand back. The sender
   * policy gates it like {@link handle}; a rejected sender or a thrown error
   * yields a structured `{ ok: false, code, message }` returnValue instead of
   * the silent drop `on` uses, so the blocked renderer always gets an answer.
   */
  handleSync(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => unknown): this {
    const policy = this.policy
    const listener = (event: IpcMainEvent, ...args: unknown[]) => {
      // Everything — including the policy check — runs inside the try so EVERY
      // path sets `event.returnValue`. sendSync blocks the renderer until it is
      // set, so an unset value (e.g. a throwing policy fn) would hang the
      // renderer forever; the catch guarantees a sentinel instead.
      try {
        if (policy && (!policy(event.sender) || !isMainFrameSender(event))) {
          console.warn(
            `[ipc] sender rejected for channel '${channel}' (${summarizeSender(event.sender)})`,
          )
          event.returnValue = {
            ok: false,
            code: 'EREJECTED',
            message: `IPC sender rejected for channel ${channel}`,
          }
          return
        }
        event.returnValue = fn(event, ...args)
      } catch (err) {
        reportListenerError(channel, err)
        const code = (err as NodeJS.ErrnoException)?.code
        event.returnValue = {
          ok: false,
          code: typeof code === 'string' ? code : 'EUNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }
    ipcMain.on(channel, listener)
    this.registry.add(() => {
      ipcMain.removeListener(channel, listener)
    })
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
          if (!policy(sender) || !isMainFrameSender(event)) {
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
