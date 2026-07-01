/**
 * Bridge between the main-process bridge-router and the simulator-resident
 * wx.* API handlers.
 *
 * The router forwards `simulator:api-call` for any name not registered in
 * `ctx.simulatorApis`. The MiniApp instance owns the handler (it can touch
 * DOM, open file pickers, read __deviceInfo, etc.), but the handlers
 * communicate results via WeChat-style success/fail/complete callback ids
 * — those ids live in the service host, not the simulator.
 *
 * `runApiAsync` runs the handler against a temporary MiniAppContext clone
 * whose `createCallbackFunction` is patched to recognise sentinel ids the
 * router substitutes for the original ids. Whichever sentinel callback is
 * invoked first (success vs fail) decides the verdict; we then echo that
 * verdict back to main, which fires the *real* service-side callbacks.
 */
import type { MiniAppContext } from './types'
import { isPersistentSimulatorApi } from '../shared/simulator-api-metadata.js'

// Loose handler signature: SimulatorMiniApp's apiRegistry binds `this` to the
// MiniApp instance (a superset of MiniAppContext); the wx.* handlers in
// simulator-api*.ts type `this` as MiniAppContext. We invoke with .call(ctx)
// where ctx prototypes the MiniApp, so structurally both shapes work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseApiHandler = (this: any, params?: unknown) => unknown | Promise<unknown>

interface MiniAppLike {
  appId: string
  apiRegistry: Record<string, LooseApiHandler | undefined>
}

export interface ApiRunVerdict {
  ok: boolean
  result?: unknown
  errMsg?: string
  /**
   * Set only for persistent-subscription (`keep: true`) APIs such as
   * `audioListen`. When true, this is one of potentially many success fires
   * of the same subscription, and main must NOT tear the call down on receipt
   * (see `handleApiResponse` in bridge-router).
   */
  keep?: boolean
}

/** Emits one response per success/fail fire back toward main. */
export type ApiEmit = (verdict: ApiRunVerdict) => void

/**
 * Run `name` against `miniApp.apiRegistry[name]` and emit a verdict via `emit`
 * as soon as the handler reports one (success/fail, throw/reject, or sync
 * return for callback-less handlers).
 *
 * The handler is invoked with `this` set to a derived context whose
 * `createCallbackFunction` recognises three sentinel symbols; the `params`
 * passed in have `success`/`fail`/`complete` (if present) rewritten to those
 * sentinels so the handler's call-through to `bindCallbacks` produces
 * callbacks routed back here.
 *
 * One-shot (default) APIs emit exactly one verdict, then go inert. Persistent
 * (`keep: true`) APIs re-emit a `{ keep: true }` verdict on EVERY subsequent
 * success fire — that is the audio/`audioListen` event-bridge path, where the
 * container's DOM media events must reach the service-side dispatcher on every
 * `play`/`timeUpdate`/`ended`, not just the first `canplay`.
 *
 * The returned promise resolves once the call has produced its first verdict
 * (for one-shot) or established its subscription (for keep); callers use it
 * only for sequencing/cleanup, never to send a response — every response goes
 * through `emit`.
 */
export function runApiAsync(
  miniApp: MiniAppLike,
  name: string,
  params: unknown,
  emit: ApiEmit,
): Promise<void> {
  const handler = miniApp.apiRegistry[name]
  if (!handler) {
    emit({ ok: false, errMsg: `${name}:fail no handler` })
    return Promise.resolve()
  }

  // Persistent subscriptions keep re-firing on every underlying event. We
  // recognise them BY NAME (`audioListen`) because the service host strips the
  // original `keep: true` before the call reaches us — see
  // shared/simulator-api-metadata.ts. The legacy `params.keep` path still works
  // for any caller that does pass it through.
  const keep =
    isPersistentSimulatorApi(name) ||
    (params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).keep === true
      : false)

  return new Promise<void>((resolve) => {
    let settled = false
    // For keep subscriptions we keep dispatching after the first fire; the
    // promise still resolves once (subscription established) so callers can
    // sequence, but `emit` is what carries every response to main.
    const finish = (verdict: ApiRunVerdict): void => {
      if (settled) {
        if (keep && verdict.ok) emit({ ...verdict, keep: true })
        return
      }
      settled = true
      emit(keep && verdict.ok ? { ...verdict, keep: true } : verdict)
      resolve()
    }

    const SUCCESS = Symbol('sim-cb-success')
    const FAIL = Symbol('sim-cb-fail')
    const COMPLETE = Symbol('sim-cb-complete')

    // Set when the handler wires the injected SUCCESS or FAIL sentinel. Wiring
    // a result callback means the handler reports its verdict THROUGH that
    // callback rather than via a synchronous return value — and, since the call
    // may resolve on a later tick (fetch, a file-picker change event, an image
    // onload, a modal's user-tap), the void it returns synchronously is not the
    // final word. We use this to tell such handlers apart from genuinely
    // synchronous ones in the sync-return path below.
    //
    // The forwarded params reach us with success/fail/complete stripped by main
    // (see forwardApiCallToSimulator in bridge-router), so the params can't tell
    // us the call is async; the wired result callback is the only signal. SUCCESS
    // alone counts: handlers like showModal wire success-only (they don't fail)
    // yet still deliver on user interaction.
    let wiredResultCallback = false

    const ctx: MiniAppContext = Object.create(miniApp as object) as MiniAppContext
    ctx.createCallbackFunction = (id: unknown) => {
      if (id === undefined || id === null) return undefined
      if (id === SUCCESS || id === FAIL) wiredResultCallback = true
      return (...args: unknown[]) => {
        const arg = args[0]
        if (id === SUCCESS) {
          finish({ ok: true, result: arg })
        } else if (id === FAIL) {
          const errMsg =
            arg && typeof arg === 'object' && 'errMsg' in (arg as Record<string, unknown>)
              ? String((arg as { errMsg?: unknown }).errMsg)
              : `${name}:fail`
          finish({ ok: false, errMsg, result: arg })
        } else if (id === COMPLETE && !keep) {
          // A handler that finishes via complete WITHOUT ever firing
          // success/fail (e.g. previewImage([]) / several fs.ts guard paths
          // early-return after onComplete). Settle so the call doesn't hang
          // until the main-side no-handler timeout. Normal handlers fire
          // success/fail first (settling), making this a no-op; keep
          // subscriptions never settle on complete.
          //
          // INVARIANT this relies on: handlers MUST fire success/fail BEFORE
          // complete (WeChat's own ordering). A handler that called complete
          // first would be settled ok:true here and its real success/fail
          // verdict dropped by the settle guard. Every simulator handler today
          // follows result-then-complete; new ones must keep to it.
          finish({ ok: true, result: arg })
        }
        // Main fires the original complete callback against the service-side id
        // once it receives our verdict.
      }
    }

    const userParams =
      params && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {}

    // Always inject ALL THREE sentinel callbacks. Main strips the caller's
    // success/fail/complete before forwarding (forwardApiCallToSimulator in
    // bridge-router), so gating injection on what the params carried would never
    // fire — the caller's callbacks are simply gone by the time we route. In
    // particular COMPLETE must always be injected: a handler whose only exit on
    // some path is `onComplete()` (previewImage([]), fs.ts guard returns) relies
    // on the COMPLETE sentinel reaching us to settle; otherwise it hangs until
    // the main-side no-handler timeout and wrongly reports a fail.
    userParams.success = SUCCESS
    userParams.fail = FAIL
    userParams.complete = COMPLETE

    try {
      const ret = (handler as LooseApiHandler).call(ctx, userParams)
      if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(ret as PromiseLike<unknown>).then(
          (r) => finish({ ok: true, result: r }),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            finish({ ok: false, errMsg: `${name}:fail ${msg}` })
          },
        )
        return
      }
      // The handler returned synchronously. If it already drove a sentinel
      // (sync success/fail), the call is settled and there is nothing to do.
      if (settled) return
      if (keep) {
        // Persistent subscription (`audioListen`): the handler bound its DOM
        // listeners and returned synchronously. Its real verdicts arrive later
        // on each media event, so resolve the promise for sequencing WITHOUT
        // emitting — emitting here would be an empty one-shot settle that marks
        // the call settled and drops every subsequent event fire.
        resolve()
        return
      }
      if (wiredResultCallback) {
        // The handler wired a success/fail callback and returned void without
        // settling: it completes asynchronously and reports through the injected
        // sentinels (request via fetch, chooseImage via the file-picker change
        // event, showModal via the user tap, downloadFile/uploadFile, …).
        // Settling here with the void return would emit a premature
        // `{ ok: true, result: undefined }` and the settle guard would then drop
        // the real verdict — the bug where a failed request fired
        // `success(undefined)` instead of `fail`. Wait for the sentinel instead.
        resolve()
        return
      }
      // No async failure path was wired: a synchronous handler. Use its return
      // value as the success result (e.g. getSystemInfoSync), or treat a void
      // fire-and-forget as a bare success.
      finish({ ok: true, result: ret })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ ok: false, errMsg: `${name}:fail ${msg}` })
    }
  })
}
