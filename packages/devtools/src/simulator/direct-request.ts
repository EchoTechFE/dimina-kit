/**
 * Direct fetch request handler for Electron environment.
 * Bypasses the /proxy endpoint — sends requests directly from the renderer process.
 *
 * This function is called with `this` bound to a MiniApp instance
 * (via MiniApp.invokeApi), so `this.createCallbackFunction` is available.
 */

import type { MiniAppContext } from './types'

export function directRequest(
  this: MiniAppContext,
  {
    url,
    data,
    header = {},
    timeout = 0,
    method = 'GET',
    dataType = 'json',
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
    success?: unknown
    fail?: unknown
    complete?: unknown
  },
) {
  const onSuccess = this.createCallbackFunction(success)
  const onFail = this.createCallbackFunction(fail)
  const onComplete = this.createCallbackFunction(complete)

  const rm = method.toUpperCase()
  const canHaveBody = rm !== 'GET' && rm !== 'HEAD'

  function parseResponse(response: Response) {
    if (!response.ok) {
      const error = Object.assign(new Error(response.statusText), { code: response.status })
      throw error
    }

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    switch (dataType) {
      case 'json':
        return response.text().then((text) => {
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { parsed = text }
          return { data: parsed, header: headers, statusCode: response.status }
        })
      case 'arraybuffer':
        return response.arrayBuffer().then((buf) => ({ data: buf, header: headers, statusCode: response.status }))
      default:
        return response.text().then((text) => ({ data: text, header: headers, statusCode: response.status }))
    }
  }

  let rurl = url
  // Merge headers case-insensitively. HTTP header names are case-insensitive,
  // but plain-object keys are not: a title-cased `Content-Type` default and a
  // caller's lowercase `content-type` are two distinct object keys, and the
  // Headers/fetch layer then joins same-named headers into one comma-separated
  // value (`application/json, application/json`). Building a Headers collapses
  // the casing so the caller's value wins exactly once, and the default is
  // applied only when the caller supplied no content-type in any casing.
  const headers = new Headers()
  for (const [k, v] of Object.entries(header)) {
    if (v != null) headers.set(k, String(v))
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  const init: RequestInit = {
    method: rm,
    headers,
  }

  if (!canHaveBody && data && typeof data === 'object' && Object.keys(data).length > 0) {
    const u = new URL(rurl)
    Object.entries(data as Record<string, unknown>).forEach(([k, v]) => u.searchParams.append(k, String(v)))
    rurl = u.toString()
  } else if (canHaveBody && data !== undefined && data !== null) {
    init.body = typeof data === 'string' ? data : JSON.stringify(data)
  }

  if (Number(timeout) > 0 && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(Number(timeout))
  }

  fetch(rurl, init)
    .then(parseResponse)
    .then((result) => {
      onSuccess?.(result)
    })
    .catch((error: Error & { code?: number }) => {
      onFail?.({ errMsg: error.message, errno: error.code })
    })
    .finally(() => {
      onComplete?.()
    })
}
