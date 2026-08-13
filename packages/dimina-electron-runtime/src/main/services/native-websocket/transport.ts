import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { WebSocket } from 'ws'

export interface NativeSocketProfile {
  connectEnd: number
  connectStart: number
  cost: number
  domainLookUpEnd: number
  domainLookUpStart: number
  fetchStart: number
  handshakeCost: number
  rtt: number
}

export interface ProfileRecorder {
  fetchStart: number
  domainLookUpStart: number
  domainLookUpEnd: number
  connectStart: number
  connectEnd: number
}

export function now(): number {
  return Date.now()
}

export function responseHeaders(response: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {}
  const raw = response.rawHeaders
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (!name || value === undefined) continue
    result[name] = result[name] ? `${result[name]}, ${value}` : value
  }
  return result
}

export function binaryMessage(data: WebSocket.RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64')
  if (Array.isArray(data)) return Buffer.concat(data).toString('base64')
  return data.toString('base64')
}

export function attachSocketProfile(
  request: ClientRequest,
  profile: ProfileRecorder,
  tcpNoDelay: boolean,
  onSocket: (socket: Socket) => void,
): void {
  const attach = (socket: Socket): void => {
    onSocket(socket)
    profile.domainLookUpStart = now()
    socket.setNoDelay(tcpNoDelay)
    socket.once('lookup', () => {
      profile.domainLookUpEnd = now()
      profile.connectStart = profile.domainLookUpEnd
    })
    const connected = (): void => {
      if (profile.domainLookUpEnd === 0) {
        profile.domainLookUpStart = profile.fetchStart
        profile.domainLookUpEnd = profile.fetchStart
      }
      if (profile.connectStart === 0) profile.connectStart = profile.domainLookUpEnd
      profile.connectEnd = now()
    }
    if ('encrypted' in socket) socket.once('secureConnect', connected)
    else socket.once('connect', connected)
  }
  if (request.socket) attach(request.socket)
  else request.once('socket', attach)
}

export function completeProfile(profile: ProfileRecorder, openedAt: number): NativeSocketProfile {
  const connectStart = profile.connectStart || profile.fetchStart
  const connectEnd = profile.connectEnd || openedAt
  const domainLookUpStart = profile.domainLookUpStart || profile.fetchStart
  const domainLookUpEnd = profile.domainLookUpEnd || domainLookUpStart
  return {
    fetchStart: profile.fetchStart,
    domainLookUpStart,
    domainLookUpEnd,
    connectStart,
    connectEnd,
    rtt: Math.max(0, connectEnd - connectStart),
    handshakeCost: Math.max(0, openedAt - connectEnd),
    cost: Math.max(0, openedAt - profile.fetchStart),
  }
}

export function errorMessage(error: Error): string {
  if (/timed?\s*out|timeout/i.test(error.message)) {
    return 'connectSocket:fail timeout'
  }
  return `connectSocket:fail ${error.message || 'WebSocket connection failed'}`
}
