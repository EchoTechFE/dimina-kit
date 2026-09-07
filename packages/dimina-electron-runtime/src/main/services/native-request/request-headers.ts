import type { NativeRequestHeaders } from './trace.js'

/** Read only after a response confirms this hop was sent. Node's public
 * getHeaders() omits automatically serialized fields such as Connection and
 * Transfer-Encoding. Keep the private HTTP/1.1 snapshot access isolated: an
 * unavailable snapshot leaves DevTools provisional without affecting I/O. */
export function captureRequestHeaders(request: unknown): NativeRequestHeaders | undefined {
  try {
    const text = (request as { _header?: unknown } | undefined)?._header
    if (typeof text !== 'string' || !text.endsWith('\r\n\r\n')) return undefined
    const lines = text.slice(0, -4).split('\r\n')
    if (!/^\S+ \S+ HTTP\/1\.1$/.test(lines.shift() ?? '')) return undefined
    const requestHeaders: Record<string, string> = Object.create(null)
    const names = new Map<string, string>()
    for (const line of lines) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon)
      if (colon < 1 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) return undefined
      const value = line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, '')
      const previous = names.get(name.toLowerCase())
      if (previous !== undefined) requestHeaders[previous] += `\n${value}`
      else {
        names.set(name.toLowerCase(), name)
        requestHeaders[name] = value
      }
    }
    return { requestHeaders, requestHeadersText: text }
  } catch {
    return undefined
  }
}
