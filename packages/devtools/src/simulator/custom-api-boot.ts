/**
 * Boot-time registration of downstream custom simulator APIs.
 *
 * The custom-API name list is fetched asynchronously over the
 * `__diminaCustomApis` bridge — an IPC round-trip through the host renderer.
 * `registerCustomApis` resolves only once every name has been handed to
 * `target.registerApi`, so the simulator entry can `await` it *before*
 * `application.presentView(...)`. That ordering guarantees the APIs are on
 * `MiniApp.apiRegistry` before the mini-app runtime boots and enumerates the
 * API surface — notably Taro's one-shot `Object.keys(wx)` at init, which
 * otherwise misses APIs that register late (e.g. `wx.login`).
 *
 * Failure modes are deliberately non-fatal: a rejected or hung `list()`
 * degrades to "no custom APIs" rather than blocking the simulator from
 * booting at all.
 *
 * Each registered handler is "callback aware": it mirrors built-in simulator
 * APIs by translating WeChat-style `success/fail/complete` callback ids into
 * real container-side callbacks (via `this.createCallbackFunction`, wrapped by
 * `bindCallbacks`). The callback ids are renderer-only and are stripped before
 * the remaining params cross the `__diminaCustomApis` bridge.
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'

export interface CustomApiRegistrar {
  registerApi(name: string, handler: (...args: unknown[]) => unknown): void
}

export interface CustomApiBridge {
  list: () => Promise<string[]>
  invoke: (name: string, params: unknown) => Promise<unknown>
}

/**
 * Deadlock breaker: how long to wait for the bridge `list()` before booting
 * without custom APIs. The list normally resolves fast (the host proxy is
 * attached before the simulator webview finishes loading); this only guards
 * against a broken/unresponsive bridge so a bug there cannot wedge the boot.
 */
export const CUSTOM_API_LIST_TIMEOUT_MS = 3000

const TIMEOUT = Symbol('custom-api-list-timeout')

export async function registerCustomApis(
  target: CustomApiRegistrar,
  bridge: CustomApiBridge | undefined,
  opts?: { timeoutMs?: number },
): Promise<void> {
  // No bridge → running outside Electron (e.g. dev-server smoke tests). No-op.
  if (!bridge) return

  const timeoutMs = opts?.timeoutMs ?? CUSTOM_API_LIST_TIMEOUT_MS

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  let names: string[] | typeof TIMEOUT
  try {
    names = await Promise.race([bridge.list(), timeout])
  } catch {
    // Bridge errored — degrade silently. Mini-app code calling the API hits
    // the same "handler missing" path as any unregistered name.
    return
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (names === TIMEOUT) {
    console.warn(
      `[simulator] custom-API list did not resolve within ${timeoutMs}ms; `
        + 'booting without downstream APIs.',
    )
    return
  }

  for (const name of names) {
    target.registerApi(name, makeCustomApiHandler(name, bridge))
  }
}

/**
 * Build a callback-aware handler for a single custom API `name`.
 *
 * The container invokes the handler as `handler.call(miniApp, params)`, so
 * `this` is the MiniApp instance and `params` carries the mini-app's call
 * options — including `success/fail/complete` *callback ids*. The handler:
 *
 *  1. strips the callback ids and forwards only the real work params over the
 *     bridge (callback ids are renderer-side and must not cross the IPC); a
 *     non-object `params` carries no callback ids and is forwarded verbatim;
 *  2. on resolve, runs the `success` callback with the bridge result;
 *  3. on reject, runs the `fail` callback with a wx-style `${name}:fail …`;
 *  4. runs `complete` in both cases;
 *  5. still returns the underlying `bridge.invoke` promise.
 */
function makeCustomApiHandler(name: string, bridge: CustomApiBridge) {
  return function customApiHandler(this: MiniAppContext, params: unknown): Promise<unknown> {
    // wx.* APIs are normally called with an options object; only such an
    // object can carry `success/fail/complete` ids. A non-object param has
    // no callback ids and is forwarded verbatim.
    const isOptions = typeof params === 'object' && params !== null
    const opts = isOptions ? params as Record<string, unknown> : {}
    const { success, fail, complete, ...rest } = opts
    const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

    const pending = bridge.invoke(name, isOptions ? rest : params)

    pending.then(
      (result) => {
        onSuccess?.(result)
        onComplete?.()
      },
      (error: unknown) => {
        const message = (error instanceof Error) ? error.message : String(error)
        onFail?.({ errMsg: `${name}:fail ${message}` })
        onComplete?.()
      },
    )

    return pending
  }
}
