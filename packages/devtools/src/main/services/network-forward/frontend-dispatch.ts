/**
 * Shared `executeJavaScript` builders for pushing raw CDP messages into the
 * embedded Chrome DevTools front-end via `window.DevToolsAPI.dispatchMessage`
 * / `dispatchMessageChunk`. Both network-forward (Network tab injection) and
 * elements-forward (Elements tab / render-event re-injection) need the exact
 * same transport contract; a single copy means the two can never drift on the
 * chunk-continuation protocol.
 */
import type { WebContents } from 'electron'
import { isFrontendSettled } from '../views/inject-when-ready.js'

/** Probe the front-end realm exposes `DevToolsAPI.dispatchMessage`. */
export const PROBE_DEVTOOLS_API
  = `(window.DevToolsAPI && typeof window.DevToolsAPI.dispatchMessage === 'function')`

/** A single dispatch payload may not exceed this many UTF-16 chars; chunk above. */
export const MAX_SINGLE_DISPATCH_CHARS = 1_000_000
export const CHUNK_CHARS = 256 * 1024

/**
 * Build the `executeJavaScript` source for a chunked dispatch of one large CDP
 * message — DevTools' own transport caps a single `dispatchMessage` payload, so
 * the front-end exposes `dispatchMessageChunk(messageChunk, messageSize)` where
 * the FIRST chunk carries the total size and EVERY SUBSEQUENT chunk is called
 * with the chunk ONLY (second arg omitted). This matches Chromium's
 * `devtools_ui_bindings.cc` DispatchProtocolMessage, whose front-end treats a
 * call with a second argument as the start of a new message and a call without
 * one as a continuation. Passing 0 (the previous behaviour) risked the
 * front-end mis-reading a continuation as a fresh 0-size message. Returns false
 * when the API isn't available.
 */
export function buildChunkedDispatchScript(chunks: string[], totalSize: number): string {
  const arr = JSON.stringify(chunks)
  return `(()=>{try{`
    + `if(!(window.DevToolsAPI&&typeof window.DevToolsAPI.dispatchMessageChunk==='function'))return false;`
    + `const cs=JSON.parse(${JSON.stringify(arr)});`
    + `for(let i=0;i<cs.length;i++){`
    + `try{`
    // First chunk: (chunk, totalSize). Subsequent chunks: (chunk) — second arg
    // omitted, NOT 0, per Chromium's continuation contract.
    + `if(i===0){window.DevToolsAPI.dispatchMessageChunk(cs[i], ${totalSize})}`
    + `else{window.DevToolsAPI.dispatchMessageChunk(cs[i])}`
    + `}catch(_){}`
    + `}`
    + `return true;`
    + `}catch(_){return false}})()`
}

/** Build the `executeJavaScript` source that dispatches ONE small CDP message
 *  (a response or event) into the front-end. Above `MAX_SINGLE_DISPATCH_CHARS`,
 *  callers must use {@link buildChunkedDispatchScript} instead. */
export function buildSingleDispatchScript(message: string): string {
  return `(()=>{try{`
    + `if(!${PROBE_DEVTOOLS_API})return false;`
    + `window.DevToolsAPI.dispatchMessage(JSON.parse(${JSON.stringify(message)}));`
    + `return true;`
    + `}catch(_){return false}})()`
}

/** One CDP command awaiting a reply — the minimal shape every outbound-gate
 *  (elements-forward, network-forward's global body gate) reads to answer. */
export interface ReplyableCommand {
  id: number | null
  sessionId: string | null
}

export interface FrontendReplyChannel {
  /** Push an arbitrary CDP-shaped message (response OR event) into the
   *  front-end, auto-chunking above the single-dispatch size cap. */
  dispatchToFrontend(message: unknown): void
  /** Reply to a front-end command id with a successful `result`. */
  replyResult(cmd: ReplyableCommand, result: unknown): void
  /** Reply to a front-end command id with the canonical CDP not-found-style
   *  error shape, so the front-end renders its normal failure state instead
   *  of leaking a forever-pending request. */
  replyError(cmd: ReplyableCommand, message: string): void
}

/**
 * Shared main → front-end reply transport for every outbound CDP gate that
 * answers commands it intercepted from `InspectorFrontendHost.sendMessageToBackend`
 * (elements-forward's render/network routing, network-forward's dedicated
 * global body gate). A single copy means the two features can never drift on
 * the settled-gate check, the chunking threshold, or the CDP reply shape.
 */
export function createFrontendReplyChannel(
  hostWc: WebContents,
  isDisposed: () => boolean,
): FrontendReplyChannel {
  function dispatchToFrontend(message: unknown): void {
    if (isDisposed() || hostWc.isDestroyed()) return
    // An unsettled front-end wipes its state on load anyway (message would be
    // meaningless there), and executeJavaScript against it queues one
    // did-stop-loading waiter per push — skip; the next settled tick re-primes.
    if (!isFrontendSettled(hostWc)) return
    let json: string
    try {
      json = JSON.stringify(message)
    } catch {
      return
    }
    if (json.length > MAX_SINGLE_DISPATCH_CHARS) {
      const chunks: string[] = []
      for (let i = 0; i < json.length; i += CHUNK_CHARS) chunks.push(json.slice(i, i + CHUNK_CHARS))
      let script: string
      try {
        script = buildChunkedDispatchScript(chunks, json.length)
      } catch {
        return
      }
      hostWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
      return
    }
    let script: string
    try {
      script = buildSingleDispatchScript(json)
    } catch {
      return
    }
    hostWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
  }

  function replyResult(cmd: ReplyableCommand, result: unknown): void {
    const msg: Record<string, unknown> = { id: cmd.id, result }
    if (cmd.sessionId) msg.sessionId = cmd.sessionId
    dispatchToFrontend(msg)
  }

  function replyError(cmd: ReplyableCommand, message: string): void {
    const msg: Record<string, unknown> = { id: cmd.id, error: { code: -32000, message } }
    if (cmd.sessionId) msg.sessionId = cmd.sessionId
    dispatchToFrontend(msg)
  }

  return { dispatchToFrontend, replyResult, replyError }
}

/**
 * Validate + iterate a drained outbound-command batch (the front-end →
 * main half of every poll-based outbound CDP gate): skips non-array batches,
 * skips malformed entries, and only ever hands `handle` an item whose
 * `method` is a string. Shared by elements-forward's render/network router
 * and network-forward's dedicated global body gate so the two can never
 * silently diverge on what counts as "well-formed".
 */
export function drainOutboundBatch<T extends { method: unknown }>(
  batch: unknown,
  handle: (cmd: T) => void,
): void {
  if (!Array.isArray(batch)) return
  for (const raw of batch) {
    if (!raw || typeof raw !== 'object') continue
    const cmd = raw as T
    if (typeof cmd.method !== 'string') continue
    handle(cmd)
  }
}

/** Minimal structural shape `answerNetworkBodyCommand` needs — satisfied by
 *  the real `NetworkBodyProvider` (network-forward/index.ts) without either
 *  module importing the other (that would be circular: index.ts already
 *  imports from this file). */
export interface NetworkBodyLookup {
  getResponseBody(requestId: string): Promise<unknown>
  getRequestPostData(requestId: string): Promise<unknown>
}

/**
 * Answer one drained front-end command that requested a virtual requestId's
 * response body / post data — the shared "network" branch every outbound CDP
 * gate that intercepts `Network.getResponseBody`/`Network.getRequestPostData`
 * needs (elements-forward's render/network router, network-forward's
 * dedicated global body gate). A missing provider or a rejected lookup
 * settles with the canonical CDP not-found error so the front-end renders
 * its normal failure state instead of leaking a forever-pending request.
 * `reply.replyResult`/`replyError` (from {@link createFrontendReplyChannel})
 * already no-op once disposed, so this never needs its own disposed guard.
 */
export function answerNetworkBodyCommand(
  cmd: ReplyableCommand & { method: string, params: unknown },
  provider: NetworkBodyLookup | undefined,
  reply: Pick<FrontendReplyChannel, 'replyResult' | 'replyError'>,
): void {
  const requestId = (cmd.params as { requestId?: unknown } | null | undefined)?.requestId
  if (!provider || typeof requestId !== 'string') {
    reply.replyError(cmd, 'No resource with given identifier found')
    return
  }
  const lookup = cmd.method === 'Network.getRequestPostData'
    ? provider.getRequestPostData(requestId)
    : provider.getResponseBody(requestId)
  lookup.then(
    (result: unknown) => reply.replyResult(cmd, result),
    (err: unknown) => reply.replyError(cmd, err instanceof Error ? err.message : String(err)),
  )
}
