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
}

/**
 * Run `name` against `miniApp.apiRegistry[name]` and resolve as soon as the
 * handler reports a verdict via success or fail (or throws / rejects / returns
 * sync for handlers without callbacks).
 *
 * The handler is invoked with `this` set to a derived context whose
 * `createCallbackFunction` recognises three sentinel symbols; the `params`
 * passed in have `success`/`fail`/`complete` (if present) rewritten to those
 * sentinels so the handler's call-through to `bindCallbacks` produces
 * callbacks routed back here.
 */
export function runApiAsync(
  miniApp: MiniAppLike,
  name: string,
  params: unknown,
): Promise<ApiRunVerdict> {
  const handler = miniApp.apiRegistry[name]
  if (!handler) {
    return Promise.resolve({ ok: false, errMsg: `${name}:fail no handler` })
  }

  return new Promise<ApiRunVerdict>((resolve) => {
    let resolved = false
    const finish = (verdict: ApiRunVerdict): void => {
      if (resolved) return
      resolved = true
      resolve(verdict)
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
