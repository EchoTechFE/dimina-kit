/**
 * Simulator-side `request` handler for the Electron environment: adapts the
 * MiniApp callback-id seam (`this.createCallbackFunction`) onto the shared
 * wx.request core. All network semantics — HTTP status never decides
 * success vs fail, timeout/abort mapping, header merging, body encoding —
 * live in shared/request-core.ts; this file must stay a thin adapter so the
 * simulator surface cannot drift from the render-window shim.
 *
 * This function is called with `this` bound to a MiniApp instance
 * (via MiniApp.invokeApi), so `this.createCallbackFunction` is available.
 */

import { performRequest } from '../shared/request-core.js'
import type { MiniAppContext } from './types'

export function directRequest(
  this: MiniAppContext,
  {
    url,
    data,
    header,
    timeout,
    method,
    dataType,
    responseType,
    success,
    fail,
    complete,
  }: {
    url: string
    data?: unknown
    header?: Record<string, string>
    timeout?: number
    method?: string
    dataType?: string
    responseType?: string
    success?: unknown
    fail?: unknown
    complete?: unknown
  },
) {
  const onSuccess = this.createCallbackFunction(success)
  const onFail = this.createCallbackFunction(fail)
  const onComplete = this.createCallbackFunction(complete)

  performRequest(
    { url, data, header, timeout, method, dataType, responseType },
    {
      success: (res) => onSuccess?.(res),
      fail: (err) => onFail?.(err),
      complete: (res) => onComplete?.(res),
    },
  )
}
