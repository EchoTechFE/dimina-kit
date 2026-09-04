import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'
import {
  addMuxedInvokeHandler,
  isMainFrameIpcSender,
  type Disposable,
  type IpcSenderPolicy,
} from '@dimina-kit/electron-deck/main'
import type { IpcContextSource } from './ipc-context-source.js'
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
export type SenderPolicy = IpcSenderPolicy

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
/** Internal marker for "this sender is not allowed on this channel". */
const REJECT = Symbol('ipc-reject')

// Channel multiplexing (one real `ipcMain.handle` per channel, dispatched to
// whichever per-window registration claims the sender — needed because the
// storage, WXML and AppData panels each register their channels once per
// window) is shared with dimina-electron-runtime's bridge router; see
// @dimina-kit/electron-deck/main's ipc-mux.ts for the mux itself.

/**
 * Tiny fluent helper that wraps every `ipcMain.handle` / `ipcMain.on` with a
 * matching removeHandler/removeListener registered into an internal registry.
 *
 * Each `register*Ipc(...)` returns one of these as a Disposable so the
 * workbench-level registry can dispose all built-in handlers in one shot.
 *
 * The constructor takes either a {@link SenderPolicy} (trust only: is this
 * sender allowed?) or an {@link IpcContextSource} (trust plus ownership: which
 * window context does this sender belong to?). With either, every incoming
 * invocation is gated:
 * - `handle` / `handleRouted`: rejected senders cause the invoke promise to
 *   reject with `Error('IPC sender rejected for channel <channel>')`.
 * - `on` / `onRouted`: rejected senders are silently dropped (the original
 *   listener is never called).
 * - `handleSync` / `handleSyncRouted`: rejected senders get a structured
 *   `{ ok: false, code: 'EREJECTED', … }` returnValue, because sendSync blocks
 *   the renderer until one is set.
 * In every case a single `console.warn` is emitted with the channel name and a
 * short sender summary. With no policy — or a source that declares itself
 * `ungated` — the wrapper is a pass-through, preserving backwards
 * compatibility for unit tests and callers that opted out.
 *
 * The `*Routed` variants hand the owning context to the handler as its first
 * argument. `TCtx` is `never` unless the registry was built from a source, so
 * they are unusable (and unreachable) on a policy-only registry.
 */
export class IpcRegistry<TCtx = never> implements Disposable {
  // Every cleanup is a synchronous ipcMain.removeHandler/removeListener call,
  // so dispose() can (and must) run them all before returning: callers
  // `dispose()` without awaiting and rely on every channel being unregistered
  // synchronously — an async registry would leave all but the first handler
  // live until a later microtask.
  private cleanups: Array<() => void> = []
  private _disposed = false
  private readonly policy: SenderPolicy | null
  private readonly source: IpcContextSource<TCtx> | null
  /** False reproduces the policy-less pass-through exactly: no main-frame
   * check, and a synchronous handler keeps its synchronous return value. */
  private readonly gated: boolean

  constructor(policyOrSource?: SenderPolicy | IpcContextSource<TCtx>) {
    const isPolicy = typeof policyOrSource === 'function'
    this.policy = isPolicy ? policyOrSource : null
    this.source = policyOrSource != null && !isPolicy ? policyOrSource : null
    this.gated = this.policy != null || (this.source != null && !this.source.ungated)
  }

  /** Trust gate and owner resolution for one incoming message. */
  private admit(event: IpcMainEvent | IpcMainInvokeEvent): TCtx | typeof REJECT {
    const source = this.source
    if (source) {
      // An ungated source always claims the sender, so the frame check — part
      // of the trust gate, not of ownership — stays off with it.
      if (source.ungated) return source.resolve(event.sender) as TCtx
      if (!isMainFrameIpcSender(event)) return REJECT
      const ctx = source.resolve(event.sender)
      return ctx == null ? REJECT : ctx
    }
    // A bare policy answers trust only, so the accepted branch carries no
    // context; `TCtx` is `never` in that mode, so no handler can observe it.
    if (!this.policy) return undefined as TCtx
    return this.policy(event.sender) && isMainFrameIpcSender(event)
      ? (undefined as TCtx)
      : REJECT
  }

  private warnRejected(channel: string, sender: WebContents): void {
    console.warn(`[ipc] sender rejected for channel '${channel}' (${summarizeSender(sender)})`)
  }

  private addInvokeHandler(
    channel: string,
    invoke: (ctx: TCtx, event: IpcMainInvokeEvent, args: unknown[]) => unknown,
  ): this {
    // The gate is `async` so a rejected sender surfaces as a *rejected
    // promise* (the invoke-result contract) rather than a synchronous throw —
    // synchronous throws can escape callers that wrap the result in
    // `Promise.resolve(...)` instead of `await`-ing it directly.
    const guarded: HandleFn = this.gated
      ? async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          const ctx = this.admit(event)
          if (ctx === REJECT) {
            this.warnRejected(channel, event.sender)
            throw new Error(`IPC sender rejected for channel ${channel}`)
          }
          return invoke(ctx, event, args)
        }
      : (event: IpcMainInvokeEvent, ...args: unknown[]) =>
          invoke(this.admit(event) as TCtx, event, args)
    this.cleanups.push(addMuxedInvokeHandler(ipcMain, channel, {
      claims: (event) => this.admit(event) !== REJECT,
      handle: guarded,
    }))
    return this
  }

  handle(channel: string, fn: HandleFn): this {
    const raw = fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown
    return this.addInvokeHandler(channel, (_ctx, event, args) => raw(event, ...args))
  }

  /** {@link handle} answered by the context that owns the calling sender. */
  handleRouted(
    channel: string,
    fn: (ctx: TCtx, event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): this {
    return this.addInvokeHandler(channel, (ctx, event, args) => fn(ctx, event, ...args))
  }

  private addSyncHandler(
    channel: string,
    invoke: (ctx: TCtx, event: IpcMainEvent, args: unknown[]) => unknown,
  ): this {
    const listener = (event: IpcMainEvent, ...args: unknown[]) => {
      const syncEvent = event as IpcMainEvent & { returnValue: unknown }
      // Everything — including the gate — runs inside the try so EVERY path
      // sets `event.returnValue`. sendSync blocks the renderer until it is
      // set, so an unset value (e.g. a throwing policy fn) would hang the
      // renderer forever; the catch guarantees a sentinel instead.
      try {
        const ctx = this.admit(event)
        if (ctx === REJECT) {
          this.warnRejected(channel, event.sender)
          syncEvent.returnValue = {
            ok: false,
            code: 'EREJECTED',
            message: `IPC sender rejected for channel ${channel}`,
          }
          return
        }
        syncEvent.returnValue = invoke(ctx, event, args)
      } catch (err) {
        reportListenerError(channel, err)
        const code = (err as NodeJS.ErrnoException)?.code
        syncEvent.returnValue = {
          ok: false,
          code: typeof code === 'string' ? code : 'EUNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }
    ipcMain.on(channel, listener)
    this.cleanups.push(() => ipcMain.removeListener(channel, listener))
    return this
  }

  /**
   * Register a SYNCHRONOUS `ipcRenderer.sendSync` handler. Unlike {@link on}
   * (fire-and-forget), the renderer is blocked until we set `event.returnValue`,
   * so `fn` MUST be synchronous and return the value to hand back.
   */
  handleSync(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => unknown): this {
    return this.addSyncHandler(channel, (_ctx, event, args) => fn(event, ...args))
  }

  /** {@link handleSync} answered by the context that owns the calling sender. */
  handleSyncRouted(
    channel: string,
    fn: (ctx: TCtx, event: IpcMainEvent, ...args: unknown[]) => unknown,
  ): this {
    return this.addSyncHandler(channel, (ctx, event, args) => fn(ctx, event, ...args))
  }

  private addListener(
    channel: string,
    invoke: (ctx: TCtx, event: IpcMainEvent, args: unknown[]) => unknown,
  ): this {
    const safeInvoke = (ctx: TCtx, event: IpcMainEvent, args: unknown[]) => {
      try {
        const ret = invoke(ctx, event, args)
        if (isThenable(ret)) {
          // Async listeners would otherwise leak rejections into Electron's
          // event loop as `UnhandledPromiseRejection`. Funnel them into the
          // same logger path as sync throws.
          Promise.resolve(ret).catch((err: unknown) => reportListenerError(channel, err))
        }
      } catch (err) {
        reportListenerError(channel, err)
      }
    }
    const guarded: ListenerFn = this.gated
      ? (event: IpcMainEvent, ...args: unknown[]) => {
          const ctx = this.admit(event)
          if (ctx === REJECT) {
            this.warnRejected(channel, event.sender)
            return
          }
          safeInvoke(ctx, event, args)
        }
      : (event: IpcMainEvent, ...args: unknown[]) =>
          safeInvoke(this.admit(event) as TCtx, event, args)
    ipcMain.on(channel, guarded)
    this.cleanups.push(() => ipcMain.removeListener(channel, guarded))
    return this
  }

  on(channel: string, fn: ListenerFn): this {
    const raw = fn as (e: IpcMainEvent, ...a: unknown[]) => unknown
    return this.addListener(channel, (_ctx, event, args) => raw(event, ...args))
  }

  /** {@link on} answered by the context that owns the calling sender. */
  onRouted(
    channel: string,
    fn: (ctx: TCtx, event: IpcMainEvent, ...args: unknown[]) => unknown,
  ): this {
    return this.addListener(channel, (ctx, event, args) => fn(ctx, event, ...args))
  }

  dispose(): Promise<void> {
    // Synchronous drain (LIFO, idempotent): every channel is unregistered
    // before this returns; the promise only carries aggregated errors.
    if (this._disposed) return Promise.resolve()
    this._disposed = true
    const items = this.cleanups.slice().reverse()
    this.cleanups = []
    const errors: unknown[] = []
    for (const cleanup of items) {
      try {
        cleanup()
      } catch (e) {
        errors.push(e)
      }
    }
    if (errors.length > 0) {
      return Promise.reject(
        new AggregateError(errors, 'IpcRegistry encountered errors during dispose'),
      )
    }
    return Promise.resolve()
  }
}
