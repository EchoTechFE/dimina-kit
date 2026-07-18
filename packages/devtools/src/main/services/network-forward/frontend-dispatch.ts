/**
 * Shared `executeJavaScript` builders for pushing raw CDP messages into the
 * embedded Chrome DevTools front-end via `window.DevToolsAPI.dispatchMessage`
 * / `dispatchMessageChunk`. Both network-forward (Network tab injection) and
 * elements-forward (Elements tab / render-event re-injection) need the exact
 * same transport contract; a single copy means the two can never drift on the
 * chunk-continuation protocol.
 */

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
