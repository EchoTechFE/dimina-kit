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

  const keep =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).keep === true
      : false

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

    const ctx: MiniAppContext = Object.create(miniApp as object) as MiniAppContext
    ctx.createCallbackFunction = (id: unknown) => {
      if (id === undefined || id === null) return undefined
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
        }
        // COMPLETE: drop. Main fires the original complete callback against
        // the service-side id once it receives our verdict.
      }
    }

    const userParams =
      params && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {}
    const hadSuccess = userParams.success !== undefined && userParams.success !== null
    const hadFail = userParams.fail !== undefined && userParams.fail !== null
    const hadComplete = userParams.complete !== undefined && userParams.complete !== null

    // Always inject sentinel callbacks so handlers that gate on the presence
    // of any callback (e.g. chooseImage's onSuccess/onFail paths) still drive
    // the verdict, even if the original caller omitted them.
    userParams.success = SUCCESS
    userParams.fail = FAIL
    if (hadComplete) userParams.complete = COMPLETE

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
      // Sync handler that ignored our injected callbacks (e.g. getSystemInfoSync)
      // — use its return value as the success result.
      if (!hadSuccess && !hadFail) {
        finish({ ok: true, result: ret })
      }
      // Otherwise: wait for the captured success/fail callback above to fire.
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ ok: false, errMsg: `${name}:fail ${msg}` })
    }
  })
}
