/**
 * Behavior tests for `addMuxedInvokeHandler` / `addMuxedSyncListener` in
 * `./ipc-mux.ts`.
 *
 * A fake `ipcMain` records every `handle` / `on` / `removeHandler` /
 * `removeListener` call so specs can pin exactly ONE real Electron
 * registration installs per channel regardless of how many owners multiplex
 * onto it, and that dispatch, fallback and teardown all match the module's
 * documented contract. Never mocks the `electron` module — the module under
 * test takes `ipcMain` as a plain argument specifically so tests do not need
 * to.
 *
 * The mux's channel maps are module state with no reset hook, so every spec
 * here must use a channel name unique within this file — reusing one makes a
 * later spec silently register onto the earlier spec's live entry list.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { addMuxedInvokeHandler, addMuxedSyncListener, type InvokeMuxEntry, type SyncMuxEntry } from './ipc-mux.js'

// ── Fake ipcMain ─────────────────────────────────────────────────────────
//
// Tracks real registrations per channel (`handle`/`on`) and their removal, so
// a spec can assert the real Electron surface was touched exactly once per
// channel no matter how many mux entries share it. `invoke`/`emit` replay a
// message through whatever handler/listener is currently installed, the same
// way Electron would deliver an actual IPC message.
function makeIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>()
  const calls: string[] = []

  const fake = {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      calls.push(`handle:${channel}`)
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      calls.push(`removeHandler:${channel}`)
      handlers.delete(channel)
    }),
    on: vi.fn((channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void) => {
      calls.push(`on:${channel}`)
      listeners.set(channel, fn)
    }),
    removeListener: vi.fn((channel: string) => {
      calls.push(`removeListener:${channel}`)
      listeners.delete(channel)
    }),
    calls,
    hasHandler: (channel: string) => handlers.has(channel),
    hasListener: (channel: string) => listeners.has(channel),
    invoke: (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no ipcMain.handle installed for '${channel}'`)
      return fn(event, ...args)
    },
    emit: (channel: string, event: IpcMainEvent, ...args: unknown[]) => {
      const fn = listeners.get(channel)
      if (!fn) return // mirrors real ipcMain.emit: no listener = silent no-op
      fn(event, ...args)
    },
  }

  // The mux takes a whole `IpcMain`, but only ever touches the four methods
  // above. Widening the fake to `IpcMain` keeps the recorder's own members
  // (`calls`, `invoke`, `emit`, the vi.fn mocks) fully typed at every call
  // site — an `as any` here would silently untype the entire file instead.
  return fake as typeof fake & IpcMain
}

/** An invoke-event stub distinguished by `sender.id`, the field real claim predicates key off. */
function invokeEvent(senderId: number): IpcMainInvokeEvent {
  return { sender: { id: senderId } } as unknown as IpcMainInvokeEvent
}

function syncEvent(senderId: number): IpcMainEvent {
  return { sender: { id: senderId }, returnValue: undefined } as unknown as IpcMainEvent
}

describe('addMuxedInvokeHandler — single real registration per channel', () => {
  it('registering three owners on the same channel calls ipcMain.handle exactly once', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-a'
    for (let i = 0; i < 3; i++) {
      addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => i })
    }
    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
    expect(ipcMain.calls.filter((c: string) => c.startsWith('handle:'))).toEqual([`handle:${channel}`])
  })

  it('two different channels each get their own real registration', () => {
    const ipcMain = makeIpcMain()
    addMuxedInvokeHandler(ipcMain, 'chan-c', { claims: () => true, handle: () => 1 })
    addMuxedInvokeHandler(ipcMain, 'chan-d', { claims: () => true, handle: () => 2 })
    expect(ipcMain.handle).toHaveBeenCalledTimes(2)
  })
})

describe('addMuxedInvokeHandler — dispatch is newest-registration-first', () => {
  it('the most recently registered claimant wins, not the first-registered one', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-dispatch'
    const order: string[] = []
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: () => true,
      handle: () => {
        order.push('first')
        return 'first'
      },
    })
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: () => true,
      handle: () => {
        order.push('second')
        return 'second'
      },
    })
    const result = ipcMain.invoke(channel, invokeEvent(1))
    // Both entries claim every event; the LAST registered must be asked first
    // and win, per the module's "newest-first" scan.
    expect(result).toBe('second')
    expect(order).toEqual(['second'])
  })

  it('dispatches by sender-scoped claim: window B never sees window A\'s handler', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-scoped'
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: (e: IpcMainInvokeEvent) => e.sender.id === 1,
      handle: () => 'owner-A',
    })
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: (e: IpcMainInvokeEvent) => e.sender.id === 2,
      handle: () => 'owner-B',
    })
    expect(ipcMain.invoke(channel, invokeEvent(1))).toBe('owner-A')
    expect(ipcMain.invoke(channel, invokeEvent(2))).toBe('owner-B')
  })
})

describe('addMuxedInvokeHandler — unclaimed falls back to the last registration, which reports its own outcome', () => {
  it('an event nobody claims is handled by the most recently registered entry', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-fallback'
    addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => 'first' })
    addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => 'last' })
    expect(ipcMain.invoke(channel, invokeEvent(99))).toBe('last')
  })

  it('single-owner behavior matches plain ipcMain.handle: the owner\'s own rejection propagates unaltered', async () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-single-reject'
    const boom = new Error('owner blew up')
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: () => false,
      handle: () => Promise.reject(boom),
    })
    // The mux must not swallow or replace this with its own error — it is the
    // sole owner's promise, unaltered.
    await expect(ipcMain.invoke(channel, invokeEvent(1))).rejects.toBe(boom)
  })

  it('single-owner synchronous throw also propagates unaltered', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-single-throw'
    const boom = new Error('sync owner blew up')
    addMuxedInvokeHandler(ipcMain, channel, {
      claims: () => false,
      handle: () => {
        throw boom
      },
    })
    expect(() => ipcMain.invoke(channel, invokeEvent(1))).toThrow(boom)
  })
})

describe('addMuxedInvokeHandler — disposer removes only its own registration', () => {
  it('disposing one of two entries leaves the other reachable and keeps the real handler installed', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-dispose'
    const disposeFirst = addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => 'first' })
    addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => 'second' })
    disposeFirst()
    expect(ipcMain.removeHandler).not.toHaveBeenCalled()
    expect(ipcMain.hasHandler(channel)).toBe(true)
    expect(ipcMain.invoke(channel, invokeEvent(1))).toBe('second')
  })

  it('disposing the last remaining entry removes the real handler and forgets the channel', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-dispose-last'
    const dispose = addMuxedInvokeHandler(ipcMain, channel, { claims: () => true, handle: () => 'only' })
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel)
    expect(ipcMain.hasHandler(channel)).toBe(false)
  })

  it('calling a disposer twice does not remove a later owner registered in between', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-double-dispose'
    const disposeFirst = addMuxedInvokeHandler(ipcMain, channel, { claims: () => false, handle: () => 'first' })
    disposeFirst() // sole owner removed → genuine teardown, one real removeHandler
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)

    // A fresh owner registers on the now-empty channel (fresh install).
    addMuxedInvokeHandler(ipcMain, channel, { claims: () => true, handle: () => 'fresh' })
    expect(ipcMain.handle).toHaveBeenCalledTimes(2)

    // The stale disposer belongs to the torn-down registration list, not the
    // fresh one — calling it again must be a no-op, not a second removeHandler
    // that would tear down the fresh owner's live registration.
    disposeFirst()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)
    expect(ipcMain.hasHandler(channel)).toBe(true)
    expect(ipcMain.invoke(channel, invokeEvent(1))).toBe('fresh')
  })

  it('re-registering after full teardown reinstalls a real ipcMain.handle', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-reinstall'
    const dispose = addMuxedInvokeHandler(ipcMain, channel, { claims: () => true, handle: () => 'a' })
    dispose()
    addMuxedInvokeHandler(ipcMain, channel, { claims: () => true, handle: () => 'b' })
    expect(ipcMain.handle).toHaveBeenCalledTimes(2)
    expect(ipcMain.invoke(channel, invokeEvent(1))).toBe('b')
  })
})

describe('addMuxedInvokeHandler — invoking after every entry is disposed throws', () => {
  it('a stray message on a fully-disposed channel throws instead of silently resolving', () => {
    const ipcMain = makeIpcMain()
    const channel = 'chan-empty-invoke'
    const dispose = addMuxedInvokeHandler(ipcMain, channel, { claims: () => true, handle: () => 'x' })
    // Capture the raw installed callback before disposal removes the map entry
    // but not the (now stale) Electron registration reference we hold.
    const rawHandle = ipcMain.handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent) => unknown
    dispose()
    expect(() => rawHandle(invokeEvent(1))).toThrow(`No handler registered for '${channel}'`)
  })
})

// ── Sync channel ─────────────────────────────────────────────────────────

describe('addMuxedSyncListener — single real registration per channel', () => {
  it('registering three owners on the same channel calls ipcMain.on exactly once', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-a'
    for (let i = 0; i < 3; i++) {
      addMuxedSyncListener(ipcMain, channel, { claims: () => false, handle: () => {} })
    }
    expect(ipcMain.on).toHaveBeenCalledTimes(1)
  })
})

describe('addMuxedSyncListener — dispatch, fallback and single-writer returnValue', () => {
  it('the newest claimant wins and is the only one to write event.returnValue', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-dispatch'
    const seen: string[] = []
    addMuxedSyncListener(ipcMain, channel, {
      claims: () => true,
      handle: (e: IpcMainEvent) => {
        seen.push('first')
        ;(e as unknown as { returnValue: unknown }).returnValue = 'first'
      },
    })
    addMuxedSyncListener(ipcMain, channel, {
      claims: () => true,
      handle: (e: IpcMainEvent) => {
        seen.push('second')
        ;(e as unknown as { returnValue: unknown }).returnValue = 'second'
      },
    })
    const event = syncEvent(1)
    ipcMain.emit(channel, event)
    expect(seen).toEqual(['second'])
    expect((event as unknown as { returnValue: unknown }).returnValue).toBe('second')
  })

  it('unclaimed falls back to the most recently registered entry', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-fallback'
    addMuxedSyncListener(ipcMain, channel, { claims: () => false, handle: () => {} })
    let ranLast = false
    addMuxedSyncListener(ipcMain, channel, {
      claims: () => false,
      handle: () => {
        ranLast = true
      },
    })
    ipcMain.emit(channel, syncEvent(1))
    expect(ranLast).toBe(true)
  })
})

describe('addMuxedSyncListener — disposer removes only its own registration', () => {
  it('disposing one of two entries keeps the real listener installed and the other reachable', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-dispose'
    let firstRan = false
    let secondRan = false
    const disposeFirst = addMuxedSyncListener(ipcMain, channel, {
      claims: () => false,
      handle: () => {
        firstRan = true
      },
    })
    addMuxedSyncListener(ipcMain, channel, {
      claims: () => false,
      handle: () => {
        secondRan = true
      },
    })
    disposeFirst()
    expect(ipcMain.removeListener).not.toHaveBeenCalled()
    ipcMain.emit(channel, syncEvent(1))
    expect(firstRan).toBe(false)
    expect(secondRan).toBe(true)
  })

  it('disposing the last remaining entry removes the real listener and forgets the channel', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-dispose-last'
    const dispose = addMuxedSyncListener(ipcMain, channel, { claims: () => true, handle: () => {} })
    dispose()
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(1)
    expect(ipcMain.removeListener).toHaveBeenCalledWith(channel, expect.any(Function))
    expect(ipcMain.hasListener(channel)).toBe(false)
  })

  it('calling a disposer twice does not remove a later owner registered in between', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-double-dispose'
    const disposeFirst = addMuxedSyncListener(ipcMain, channel, { claims: () => false, handle: () => {} })
    disposeFirst() // sole owner removed → genuine teardown, one real removeListener
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(1)

    let freshRan = false
    addMuxedSyncListener(ipcMain, channel, {
      claims: () => true,
      handle: () => {
        freshRan = true
      },
    })
    // The stale disposer belongs to the torn-down registration list — calling
    // it again must not remove the fresh owner's live listener.
    disposeFirst()
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(1)
    ipcMain.emit(channel, syncEvent(1))
    expect(freshRan).toBe(true)
  })
})

describe('addMuxedSyncListener — a stray message on a fully-disposed channel does not write returnValue', () => {
  it('the raw installed listener leaves returnValue untouched once every entry is gone', () => {
    const ipcMain = makeIpcMain()
    const channel = 'sync-empty'
    const dispose = addMuxedSyncListener(ipcMain, channel, {
      claims: () => true,
      handle: (e: IpcMainEvent) => {
        ;(e as unknown as { returnValue: unknown }).returnValue = 'should not happen'
      },
    })
    const rawListener = ipcMain.on.mock.calls[0]![1] as (event: IpcMainEvent) => void
    dispose()
    const event = syncEvent(1)
    expect(() => rawListener(event)).not.toThrow()
    expect((event as unknown as { returnValue: unknown }).returnValue).toBeUndefined()
  })
})

// Type-only smoke: entries conform to the exported shapes without needing a
// cast, guarding the public `InvokeMuxEntry` / `SyncMuxEntry` surface.
describe('exported entry types', () => {
  it('accept a plain claims/handle object', () => {
    const invokeEntry: InvokeMuxEntry = { claims: () => true, handle: () => 'ok' }
    const syncEntry: SyncMuxEntry = { claims: () => true, handle: () => {} }
    expect(typeof invokeEntry.handle).toBe('function')
    expect(typeof syncEntry.handle).toBe('function')
  })
})
