import type { MiniAppContext } from './types'

/**
 * Resolve the success / fail / complete callbacks of a wx.* API options
 * object in one step. Each runs through ctx.createCallbackFunction so it is
 * invoked with the proper this-binding; a missing option yields undefined.
 */
export function bindCallbacks(
  ctx: MiniAppContext,
  opts: { success?: unknown; fail?: unknown; complete?: unknown },
) {
  return {
    onSuccess: ctx.createCallbackFunction(opts.success),
    onFail: ctx.createCallbackFunction(opts.fail),
    onComplete: ctx.createCallbackFunction(opts.complete),
  }
}

/**
 * Build a wx.* API stub for a capability the simulator cannot provide. The
 * returned function reports `${apiName}:fail not supported in simulator`
 * through the fail callback, then runs complete.
 */
export function notSupportedApi(
  apiName: string,
): (this: MiniAppContext, opts?: { fail?: unknown; complete?: unknown }) => void {
  return function (this: MiniAppContext, opts: { fail?: unknown; complete?: unknown } = {}) {
    const { onFail, onComplete } = bindCallbacks(this, opts)
    onFail?.({ errMsg: `${apiName}:fail not supported in simulator` })
    onComplete?.()
  }
}
