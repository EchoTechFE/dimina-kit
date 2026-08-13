import type {
  NativeWebSocketCallbackEmitter,
  NativeWebSocketEventName,
  NativeWebSocketEventSubscription,
} from './types.js'

const TERMINAL_REPLAY_CAPACITY = 32

type CallbackId = unknown

interface ReplayEntry {
  payload: Record<string, unknown>
  deliveredCallbackIds: Set<CallbackId>
}

interface SocketListeners {
  listeners: Record<NativeWebSocketEventName, Set<CallbackId>>
  openPayload?: Record<string, unknown>
  openDeliveredCallbackIds: Set<CallbackId>
}

interface OwnerEvents {
  emitter?: NativeWebSocketCallbackEmitter
  sockets: Map<string, SocketListeners>
  openReplay: Map<string, ReplayEntry>
  terminalReplay: Map<string, ReplayEntry>
}

function usableCallbackId(callbackId: CallbackId): boolean {
  return callbackId !== undefined && callbackId !== null && callbackId !== ''
}

function createSocketListeners(): SocketListeners {
  return {
    listeners: {
      open: new Set(),
      message: new Set(),
      error: new Set(),
      close: new Set(),
    },
    openDeliveredCallbackIds: new Set(),
  }
}

/** Owns bridge callback registration and late open/error/close replay. */
export class NativeWebSocketEventRegistry {
  private readonly owners = new Map<string, OwnerEvents>()

  beginSocket(ownerId: string, socketId: string): void {
    const owner = this.owner(ownerId)
    owner.sockets.set(socketId, createSocketListeners())
    owner.openReplay.delete(socketId)
    owner.terminalReplay.delete(this.replayKey(socketId, 'error'))
    owner.terminalReplay.delete(this.replayKey(socketId, 'close'))
  }

  on(
    ownerId: string,
    event: NativeWebSocketEventName,
    subscription: NativeWebSocketEventSubscription,
    emitter: NativeWebSocketCallbackEmitter,
  ): void {
    const owner = this.owner(ownerId)
    owner.emitter = emitter
    if (!subscription.socketId || !usableCallbackId(subscription.callback)) return
    const socket = owner.sockets.get(subscription.socketId)
    if (socket) socket.listeners[event].add(subscription.callback)
    this.replay(owner, subscription.socketId, event, subscription.callback)
  }

  off(
    ownerId: string,
    event: NativeWebSocketEventName,
    subscription: NativeWebSocketEventSubscription,
  ): void {
    const owner = this.owners.get(ownerId)
    if (!owner || !subscription.socketId) return
    const listeners = owner.sockets.get(subscription.socketId)?.listeners[event]
    if (listeners) {
      if (usableCallbackId(subscription.callback)) listeners.delete(subscription.callback)
      else listeners.clear()
    }
    const delivered = event === 'open'
      ? owner.sockets.get(subscription.socketId)?.openDeliveredCallbackIds
        ?? owner.openReplay.get(subscription.socketId)?.deliveredCallbackIds
      : event === 'error' || event === 'close'
        ? owner.terminalReplay.get(this.replayKey(subscription.socketId, event))?.deliveredCallbackIds
        : undefined
    if (!delivered) return
    if (usableCallbackId(subscription.callback)) delivered.delete(subscription.callback)
    else delivered.clear()
  }

  dispatch(
    ownerId: string,
    socketId: string,
    event: NativeWebSocketEventName,
    payload: Record<string, unknown>,
    options: { detach?: boolean; replayTerminal?: boolean } = {},
  ): void {
    const owner = this.owners.get(ownerId)
    if (!owner) return
    const socket = owner.sockets.get(socketId)
    let delivered: Set<CallbackId> | undefined
    if (event === 'open' && socket) {
      socket.openPayload = payload
      delivered = socket.openDeliveredCallbackIds
    } else if (options.replayTerminal && (event === 'error' || event === 'close')) {
      delivered = this.recordTerminal(owner, socketId, event, payload).deliveredCallbackIds
    }
    for (const callbackId of socket?.listeners[event] ?? []) {
      this.emitOnce(owner, callbackId, payload, delivered)
    }
    if (options.detach) {
      if (socket?.openPayload) {
        this.recordOpenReplay(owner, socketId, socket.openPayload, socket.openDeliveredCallbackIds)
      }
      owner.sockets.delete(socketId)
    }
  }

  detachSocket(ownerId: string, socketId: string): void {
    this.owners.get(ownerId)?.sockets.delete(socketId)
  }

  disposeOwner(ownerId: string): void {
    this.owners.delete(ownerId)
  }

  dispose(): void {
    this.owners.clear()
  }

  private owner(ownerId: string): OwnerEvents {
    let owner = this.owners.get(ownerId)
    if (!owner) {
      owner = { sockets: new Map(), openReplay: new Map(), terminalReplay: new Map() }
      this.owners.set(ownerId, owner)
    }
    return owner
  }

  private replay(
    owner: OwnerEvents,
    socketId: string,
    event: NativeWebSocketEventName,
    callbackId: CallbackId,
  ): void {
    if (event === 'open') {
      const socket = owner.sockets.get(socketId)
      const replay = socket?.openPayload
        ? { payload: socket.openPayload, deliveredCallbackIds: socket.openDeliveredCallbackIds }
        : owner.openReplay.get(socketId)
      if (replay) this.emitOnce(owner, callbackId, replay.payload, replay.deliveredCallbackIds)
      return
    }
    if (event === 'error' || event === 'close') {
      const replay = owner.terminalReplay.get(this.replayKey(socketId, event))
      if (replay) this.emitOnce(owner, callbackId, replay.payload, replay.deliveredCallbackIds)
    }
  }

  private emitOnce(
    owner: OwnerEvents,
    callbackId: CallbackId,
    payload: Record<string, unknown>,
    delivered?: Set<CallbackId>,
  ): void {
    if (delivered?.has(callbackId)) return
    delivered?.add(callbackId)
    owner.emitter?.(callbackId, payload)
  }

  private recordOpenReplay(
    owner: OwnerEvents,
    socketId: string,
    payload: Record<string, unknown>,
    deliveredCallbackIds: Set<CallbackId>,
  ): void {
    owner.openReplay.delete(socketId)
    owner.openReplay.set(socketId, { payload, deliveredCallbackIds })
    while (owner.openReplay.size > TERMINAL_REPLAY_CAPACITY) {
      const oldest = owner.openReplay.keys().next().value
      if (oldest === undefined) break
      owner.openReplay.delete(oldest)
    }
  }

  private recordTerminal(
    owner: OwnerEvents,
    socketId: string,
    event: 'error' | 'close',
    payload: Record<string, unknown>,
  ): ReplayEntry {
    const key = this.replayKey(socketId, event)
    const replay = { payload, deliveredCallbackIds: new Set<CallbackId>() }
    owner.terminalReplay.delete(key)
    owner.terminalReplay.set(key, replay)
    while (owner.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
      const oldest = owner.terminalReplay.keys().next().value
      if (oldest === undefined) break
      owner.terminalReplay.delete(oldest)
    }
    return replay
  }

  private replayKey(socketId: string, event: 'error' | 'close'): string {
    return `${socketId}|${event}`
  }
}
