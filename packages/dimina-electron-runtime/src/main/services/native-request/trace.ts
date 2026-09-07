/**
 * Pure observation stream of the native (main-process) HTTP transport,
 * parallel to native-websocket's `NativeWebSocketTrace` (trace.ts there) and
 * built for the same reason: `wx.request` now runs on Node http/https in the
 * main process, so no `webContents.debugger` attached to the simulator can
 * see it — the embedded DevTools Network tab would otherwise show nothing for
 * every request. One event per lifecycle fact, in the order the facts
 * happen; every `sent` requestId is followed by exactly one terminal event
 * (`finished` or `failed`), so a downstream CDP synthesizer can rely on
 * sent→redirect*→(response)?→terminal without tracking transport state itself.
 *
 * `time` is wall-clock milliseconds (`Date.now()`); CDP consumers divide by
 * 1000 for `timestamp`/`wallTime`.
 */
/** Matches the Network body cache's per-entry character budget. */
export const NATIVE_REQUEST_TRACE_MAX_CHARS = 16 * 1024 * 1024

export interface NativeRequestRedirectResponse {
  url: string
  status: number
  statusText: string
  headers: Record<string, string>
}

export type NativeRequestTrace =
  | {
      type: 'redirect'
      requestId: string
      url: string
      method: string
      headers: Record<string, string>
      postData?: string
      hasPostData?: boolean
      redirectResponse: NativeRequestRedirectResponse
      time: number
    }
  | {
      type: 'sent'
      requestId: string
      url: string
      method: string
      headers: Record<string, string>
      postData?: string
      hasPostData?: boolean
      time: number
    }
  | {
      type: 'response'
      requestId: string
      status: number
      statusText: string
      headers: Record<string, string>
      time: number
    }
  | {
      type: 'finished'
      requestId: string
      /** Missing when the body exceeds the observation budget; never partial data. */
      body?: string
      bodyBase64Encoded: boolean
      encodedDataLength: number
      time: number
    }
  | { type: 'failed'; requestId: string; errorText: string; time: number }

/**
 * Single observer of the trace stream (set via `setTracer`). Independent from
 * the per-owner business result the caller awaits: registering or clearing
 * the tracer never alters request behaviour, and the tracer's own exceptions
 * are swallowed at the emission site so observation can never break a live
 * request.
 */
export type NativeRequestTracer = (ownerId: string, event: NativeRequestTrace) => void

/**
 * Per-request trace emitter. Every method no-ops (before building any
 * payload) when no tracer is registered; a throwing tracer is swallowed with a warning. `finished`/
 * `failed` are mutually exclusive terminals — the transport calls at most one
 * of them per request.
 */
export interface RequestTracer {
  sent(url: string, method: string, headers: Record<string, string>, postData?: string): void
  redirect(url: string, method: string, headers: Record<string, string>, postData: string | undefined, response: NativeRequestRedirectResponse): void
  response(status: number, statusText: string, headers: Record<string, string>): void
  finished(body: string | (() => string), bodyBase64Encoded: boolean, encodedDataLength: number, decodedDataLength?: number): void
  failed(errorText: string): void
}

export function createRequestTracer(
  getTracer: () => NativeRequestTracer | undefined,
  ownerId: string,
  requestId: string,
): RequestTracer {
  return new RequestTracerImpl(getTracer, ownerId, requestId)
}

class RequestTracerImpl implements RequestTracer {
  constructor(
    private readonly getTracer: () => NativeRequestTracer | undefined,
    private readonly ownerId: string,
    private readonly requestId: string,
  ) {}

  private emit(event: NativeRequestTrace): void {
    const tracer = this.getTracer()
    if (!tracer) return
    try {
      tracer(this.ownerId, event)
    } catch (error) {
      console.warn('[native-request] tracer threw:', error)
    }
  }

  sent(url: string, method: string, headers: Record<string, string>, postData?: string): void {
    if (!this.getTracer()) return
    const event: NativeRequestTrace = { type: 'sent', requestId: this.requestId, url, method, headers: { ...headers },
      ...boundedPostData(postData), time: Date.now() }
    this.emit(event)
  }

  response(status: number, statusText: string, headers: Record<string, string>): void {
    if (!this.getTracer()) return
    this.emit({ type: 'response', requestId: this.requestId, status, statusText, headers: { ...headers }, time: Date.now() })
  }

  redirect(url: string, method: string, headers: Record<string, string>, postData: string | undefined, response: NativeRequestRedirectResponse): void {
    if (!this.getTracer()) return
    this.emit({ type: 'redirect', requestId: this.requestId, url, method, headers: { ...headers },
      ...boundedPostData(postData),
      redirectResponse: { ...response, headers: { ...response.headers } }, time: Date.now() })
  }

  finished(body: string | (() => string), bodyBase64Encoded: boolean, encodedDataLength: number, decodedDataLength = encodedDataLength): void {
    if (!this.getTracer()) return
    const encodedChars = bodyBase64Encoded ? Math.ceil(decodedDataLength / 3) * 4 : decodedDataLength
    const value = encodedChars <= NATIVE_REQUEST_TRACE_MAX_CHARS
      ? typeof body === 'function' ? body() : body
      : undefined
    this.emit({
      type: 'finished',
      requestId: this.requestId,
      ...(value !== undefined && value.length <= NATIVE_REQUEST_TRACE_MAX_CHARS ? { body: value } : {}),
      bodyBase64Encoded,
      encodedDataLength,
      time: Date.now(),
    })
  }

  failed(errorText: string): void {
    if (!this.getTracer()) return
    this.emit({ type: 'failed', requestId: this.requestId, errorText, time: Date.now() })
  }
}

function boundedPostData(postData?: string): { postData?: string; hasPostData?: boolean } {
  if (postData === undefined) return {}
  return postData.length <= NATIVE_REQUEST_TRACE_MAX_CHARS ? { postData } : { hasPostData: true }
}
