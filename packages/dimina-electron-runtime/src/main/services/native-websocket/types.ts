import type { NativeSocketProfile } from './transport.js'
import type { NativeWebSocketTracer } from './trace.js'

export type NativeWebSocketEventName = 'open' | 'message' | 'error' | 'close'
export type NativeWebSocketCallbackEmitter = (callbackId: unknown, payload: Record<string, unknown>) => void

export interface NativeWebSocketEventSubscription {
  socketId: string
  callback: unknown
}

export type NativeWebSocketEvent =
  | {
      socketId: string
      event: 'open'
      header: Record<string, string>
      profile: NativeSocketProfile
    }
  | {
      socketId: string
      event: 'message'
      data: string
      isBuffer?: true
    }
  | {
      socketId: string
      event: 'error'
      errMsg: string
    }
  | {
      socketId: string
      event: 'close'
      code: number
      reason: string
    }

export interface NativeConnectSocketOptions {
  socketId: string
  url: string
  header?: Record<string, unknown>
  protocols?: string[]
  timeout?: number
  perMessageDeflate?: boolean
  tcpNoDelay?: boolean
  /**
   * Kept for wx.connectSocket contract compatibility. A desktop developer tool
   * cannot select a cellular interface, so true is an explicit no-op.
   */
  forceCellularNetwork?: boolean
  /** Container-owned Referer added after caller headers are filtered. */
  containerReferer?: string
}

export interface NativeSendSocketMessageOptions {
  socketId: string
  data: unknown
  isBuffer?: boolean
}

export interface NativeCloseSocketOptions {
  socketId: string
  code?: number
  reason?: string
}

export interface NativeWebSocketResult {
  errMsg: string
}

export interface NativeWebSocketServiceOptions {
  /**
   * Client-side power-saving idle teardown. WeChat documents the mechanism
   * ("长连超过一段时间没有任何网络传输时，客户端会主动关闭") without any
   * duration, so the default 0 disables it; devtools users/tests opt in.
   */
  idleTimeoutMs?: number
  /** Background grace before live sockets are interrupted. Default 5000. */
  backgroundGraceMs?: number
}

export interface NativeWebSocketService {
  /** Diagnostic observer used by transport contract tests; bridge delivery uses onSocketEvent. */
  listen(ownerId: string, listener: (event: NativeWebSocketEvent) => void): void
  onSocketEvent(
    ownerId: string,
    event: NativeWebSocketEventName,
    subscription: NativeWebSocketEventSubscription,
    emitter: NativeWebSocketCallbackEmitter,
  ): void
  offSocketEvent(
    ownerId: string,
    event: NativeWebSocketEventName,
    subscription: NativeWebSocketEventSubscription,
  ): void
  connect(ownerId: string, options: NativeConnectSocketOptions): NativeWebSocketResult
  send(ownerId: string, options: NativeSendSocketMessageOptions): Promise<NativeWebSocketResult>
  close(ownerId: string, options: NativeCloseSocketOptions): NativeWebSocketResult
  setBackgrounded(backgrounded: boolean): void
  /** Register the single trace observer (see trace.ts). Pure observation:
   * never alters API behaviour. Pass undefined to clear. */
  setTracer(tracer: NativeWebSocketTracer | undefined): void
  disposeOwner(ownerId: string): void
  dispose(): void
}
