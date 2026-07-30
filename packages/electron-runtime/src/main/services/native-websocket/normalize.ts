export const DEFAULT_SOCKET_TIMEOUT_MS = 60_000
export const MAX_SOCKET_TASKS = 5
export const MAX_CLOSE_REASON_BYTES = 123

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'referer',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
])

export function apiError(name: string, message: string): Error {
  return new Error(`${name}:fail ${message}`)
}

export function apiFailureResult(name: string, error: unknown): { errMsg: string } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    errMsg: message.startsWith(`${name}:fail`) ? message : `${name}:fail ${message}`,
  }
}

export function normalizeSocketUrl(raw: unknown): string {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw apiError('connectSocket', 'invalid url')
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.hash) {
    throw apiError('connectSocket', 'invalid url')
  }
  return url.toString()
}

export function normalizeTimeout(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SOCKET_TIMEOUT_MS
  const timeout = Number(raw)
  if (!Number.isFinite(timeout) || timeout > 0x7fff_ffff) {
    throw apiError('connectSocket', 'invalid timeout')
  }
  if (timeout <= 0) return DEFAULT_SOCKET_TIMEOUT_MS
  return Math.floor(timeout)
}

export function normalizeProtocols(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw apiError('connectSocket', 'protocols must be an array')
  const list: unknown[] = raw
  return list.map((protocol) => {
    if (typeof protocol !== 'string' || !protocol) {
      throw apiError('connectSocket', 'invalid protocol')
    }
    return protocol
  })
}

export function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('connectSocket', 'header must be an object')
  }
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedName = name.trim()
    const lowerName = normalizedName.toLowerCase()
    if (!normalizedName || FORBIDDEN_REQUEST_HEADERS.has(lowerName)) continue
    if (/[\r\n]/.test(normalizedName)) {
      throw apiError('connectSocket', 'invalid header')
    }
    if (value === undefined || value === null) continue
    const normalizedValue = String(value)
    if (/[\r\n]/.test(normalizedValue)) {
      throw apiError('connectSocket', 'invalid header')
    }
    result[normalizedName] = normalizedValue
  }
  return result
}

export function ensureSocketOrigin(headers: Record<string, string>, socketUrl: string): void {
  if (Object.keys(headers).some(name => name.toLowerCase() === 'origin')) return
  const origin = new URL(socketUrl)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  origin.pathname = '/'
  origin.search = ''
  origin.hash = ''
  headers.Origin = origin.origin
}

export function normalizeSendData(data: unknown): string | Buffer {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw apiError('sendSocketMessage', 'data must be string or ArrayBuffer')
}

export function validateClose(code: unknown, reason: unknown): { code: number; reason: string } {
  const normalizedCode = code === undefined ? 1000 : Number(code)
  if (
    !Number.isInteger(normalizedCode)
    || (normalizedCode !== 1000 && (normalizedCode < 3000 || normalizedCode > 4999))
  ) {
    throw apiError('closeSocket', 'invalid code')
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw apiError('closeSocket', 'reason must be a string')
  }
  const normalizedReason = reason ?? ''
  if (Buffer.byteLength(normalizedReason, 'utf8') > MAX_CLOSE_REASON_BYTES) {
    throw apiError('closeSocket', `reason must not exceed ${MAX_CLOSE_REASON_BYTES} UTF-8 bytes`)
  }
  return { code: normalizedCode, reason: normalizedReason }
}
