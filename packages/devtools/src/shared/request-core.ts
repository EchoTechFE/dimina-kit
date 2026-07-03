/**
 * Single authoritative implementation of wx.request network semantics, shared
 * by every request surface (simulator `directRequest`, preload api-compat
 * `wx.request` shim). Keeping the semantics in one module is what prevents the
 * surfaces from drifting apart on the core contract.
 *
 * The contract (official wx.request semantics):
 *  - success vs fail is decided ONLY by whether a server response was
 *    received. Any HTTP response — 200, 401, 500 — resolves via `success`
 *    with `{ data, statusCode, header, errMsg: 'request:ok' }`; callers
 *    branch on `statusCode` (e.g. 401 → re-login).
 *  - `fail` fires only for network-layer failures and always carries a
 *    non-empty errMsg: 'request:fail timeout' (deadline hit),
 *    'request:fail abort' (caller aborted), 'request:fail <reason>' (DNS/
 *    connection/protocol errors).
 *  - `timeout` defaults to 60000ms (the wx default) when omitted or
 *    non-positive — a request never hangs indefinitely.
 *  - `dataType` (default 'json') controls body decoding: 'json' attempts
 *    JSON.parse with raw-text fallback; anything else keeps raw text.
 *    `responseType: 'arraybuffer'` (or the legacy `dataType: 'arraybuffer'`
 *    spelling) yields an ArrayBuffer instead.
 *  - Outgoing headers merge case-insensitively via `Headers` so a caller's
 *    `content-type` in any casing wins exactly once; the `application/json`
 *    default applies only when the caller supplied none. Plain-object merges
 *    would keep both casings as distinct keys and comma-join them on the wire.
 *  - GET/HEAD serialize object `data` into URL query params (no body);
 *    other methods send string data verbatim, form-encode objects under
 *    application/x-www-form-urlencoded, and JSON-encode otherwise.
 *  - `complete` fires exactly once, after success or fail, with that same
 *    result object.
 *
 * Not provided: `cookies` on the success result — fetch() cannot read
 * Set-Cookie response headers, so surfacing a fabricated list would lie.
 */

export interface RequestSuccessResult {
  data: unknown
  statusCode: number
  header: Record<string, string>
  errMsg: 'request:ok'
}

export interface RequestFailResult {
  errMsg: string
  errno?: number
}

export interface RequestHandle {
  abort(): void
}

export interface RequestCoreOptions {
  url: string
  data?: unknown
  header?: Record<string, string>
  timeout?: number
  method?: string
  dataType?: string
  responseType?: string
}

export interface RequestCoreCallbacks {
  success?: (res: RequestSuccessResult) => void
  fail?: (err: RequestFailResult) => void
  complete?: (res: RequestSuccessResult | RequestFailResult) => void
}

/**
 * The wx.request default timeout budget. Exported as the single source of
 * truth for every layer that reasons about a request's time budget — the
 * bridge-router watchdog (apiCallWatchdogMs in simulator-api-metadata.ts)
 * derives its window from this so the two cannot drift apart.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Largest delay setTimeout honours (2^31-1 ms). Anything above overflows the
 * signed-32-bit timer register and fires ~immediately (~1ms) instead of late —
 * so an oversized caller timeout must be rejected, never passed through.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Resolve a caller-supplied wx timeout into a usable budget: a finite positive
 * number within setTimeout's range is honoured; anything else (absent, 0,
 * negative, NaN, Infinity, overflowing) falls back to the wx default. Shared
 * by performRequest and the bridge-router watchdog (apiCallWatchdogMs) so the
 * two layers can never disagree on what a valid timeout is.
 */
export function resolveTimeoutBudgetMs(timeout: unknown): number {
  const t = Number(timeout)
  return Number.isFinite(t) && t > 0 && t <= MAX_TIMEOUT_MS ? t : DEFAULT_REQUEST_TIMEOUT_MS
}

function buildHeaders(header: Record<string, string> | undefined): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(header ?? {})) {
    if (value != null) headers.set(key, String(value))
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return headers
}

function appendQueryParams(url: string, data: Record<string, unknown>): string {
  // Resolve against the current document when available so page-relative URLs
  // keep working in the render-window shim.
  const base = typeof location !== 'undefined' ? location.href : undefined
  const resolved = new URL(url, base)
  for (const [key, value] of Object.entries(data)) {
    resolved.searchParams.append(key, String(value))
  }
  return resolved.toString()
}

function encodeBody(data: unknown, contentType: string): BodyInit {
  if (typeof data === 'string') return data
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      form.append(key, String(value))
    }
    return form.toString()
  }
  return JSON.stringify(data)
}

async function decodeResponseData(
  response: Response,
  dataType: string,
  responseType: string,
): Promise<unknown> {
  if (responseType === 'arraybuffer' || dataType === 'arraybuffer') {
    return response.arrayBuffer()
  }
  const text = await response.text()
  if (dataType !== 'json') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function performRequest(
  opts: RequestCoreOptions,
  callbacks: RequestCoreCallbacks,
): RequestHandle {
  const method = (opts.method || 'GET').toUpperCase()
  const canHaveBody = method !== 'GET' && method !== 'HEAD'
  const headers = buildHeaders(opts.header)

  let url = opts.url
  const init: RequestInit = { method, headers }

  if (!canHaveBody) {
    if (opts.data && typeof opts.data === 'object') {
      url = appendQueryParams(url, opts.data as Record<string, unknown>)
    }
  } else if (opts.data != null) {
    init.body = encodeBody(opts.data, headers.get('content-type') ?? '')
  }

  const controller = new AbortController()
  init.signal = controller.signal

  // First verdict wins: a timeout/abort settles the call even though the fetch
  // promise is still pending, and the fetch's own late resolution/AbortError
  // rejection must not fire a second callback round.
  let settled = false

  function settleSuccess(res: RequestSuccessResult): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    callbacks.success?.(res)
    callbacks.complete?.(res)
  }

  function settleFail(err: RequestFailResult): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    callbacks.fail?.(err)
    callbacks.complete?.(err)
  }

  const timeoutMs = resolveTimeoutBudgetMs(opts.timeout)
  const timer = setTimeout(() => {
    settleFail({ errMsg: 'request:fail timeout' })
    controller.abort()
  }, timeoutMs)

  const dataType = opts.dataType ?? 'json'
  const responseType = opts.responseType ?? 'text'

  fetch(url, init)
    .then(async (response) => {
      const header: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        header[key] = value
      })
      const data = await decodeResponseData(response, dataType, responseType)
      settleSuccess({ data, statusCode: response.status, header, errMsg: 'request:ok' })
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      settleFail({ errMsg: `request:fail ${reason || 'network error'}` })
    })

  return {
    abort() {
      settleFail({ errMsg: 'request:fail abort' })
      controller.abort()
    },
  }
}
