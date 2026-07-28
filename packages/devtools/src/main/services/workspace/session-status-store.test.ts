/**
 * SessionStatusStore — the queryable main-process authority over the active
 * project's compile status.
 *
 * Contracts pinned here:
 *  - phase mapping: 'compiling' → compiling, 'error' → error, anything else
 *    (including future non-error chatter) → ready
 *  - `generation` is monotonic per record; `waitForSettled({ afterGeneration })`
 *    never accepts a state recorded at or before that generation — the guard
 *    that stops `project_open` from claiming the PREVIOUS session's 'ready'
 *  - watcherAlive is a session-lifetime fact: set false by `watcher: 'dead'`,
 *    kept false through rebuild 'ready' chatter, reset only by the next
 *    'compiling' (fresh open)
 *  - timeout rejection names the last observed phase
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSessionStatusStore } from './session-status-store.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionStatusStore — snapshot recording', () => {
  it('starts idle at generation 0 and bumps generation on every record', () => {
    const store = createSessionStatusStore()
    expect(store.get()).toMatchObject({ phase: 'idle', generation: 0, watcherAlive: true })

    store.record({ status: 'compiling', message: '编译中' })
    expect(store.get()).toMatchObject({ phase: 'compiling', message: '编译中', generation: 1 })

    store.record({ status: 'ready', message: '编译完成' })
    expect(store.get()).toMatchObject({ phase: 'ready', generation: 2 })

    store.record({ status: 'error', message: 'boom' })
    expect(store.get()).toMatchObject({ phase: 'error', message: 'boom', generation: 3 })
  })

  it('maps unknown non-error status chatter to ready (pipeline not mid-flight)', () => {
    const store = createSessionStatusStore()
    store.record({ status: 'something-new', message: '' })
    expect(store.get().phase).toBe('ready')
  })

  it('watcher death is sticky across rebuild ready chatter; only the next compiling resets it', () => {
    const store = createSessionStatusStore()
    store.record({ status: 'compiling', message: '' })
    store.record({ status: 'ready', message: '', watcher: 'dead' })
    expect(store.get().watcherAlive).toBe(false)

    // Rebuild 'ready' without the watcher flag must NOT resurrect it.
    store.record({ status: 'ready', message: 'rebuilt' })
    expect(store.get().watcherAlive).toBe(false)

    // A fresh compile (new open) starts a new session-lifetime fact.
    store.record({ status: 'compiling', message: '' })
    expect(store.get().watcherAlive).toBe(true)
  })
})

describe('SessionStatusStore — waitForSettled', () => {
  it('resolves immediately when the current snapshot is already settled', async () => {
    const store = createSessionStatusStore()
    store.record({ status: 'ready', message: 'ok' })
    await expect(store.waitForSettled({ timeoutMs: 1000 })).resolves.toMatchObject({
      phase: 'ready',
      generation: 1,
    })
  })

  it('does not accept a settled state recorded at or before afterGeneration', async () => {
    const store = createSessionStatusStore()
    // A previous session settled at generation 1.
    store.record({ status: 'ready', message: 'previous session' })

    const settled = store.waitForSettled({ afterGeneration: 1, timeoutMs: 1000 })
    let resolved = false
    settled.then(() => { resolved = true })

    // Give a microtask turn: the stale 'ready' must NOT resolve the wait.
    await Promise.resolve()
    expect(resolved).toBe(false)

    store.record({ status: 'compiling', message: '' }) // gen 2, not settled
    store.record({ status: 'ready', message: 'this session' }) // gen 3, settled
    await expect(settled).resolves.toMatchObject({ phase: 'ready', generation: 3 })
  })

  it('skips intermediate compiling records and resolves on error too', async () => {
    const store = createSessionStatusStore()
    const settled = store.waitForSettled({ afterGeneration: 0, timeoutMs: 1000 })
    store.record({ status: 'compiling', message: '' })
    store.record({ status: 'error', message: 'boom' })
    await expect(settled).resolves.toMatchObject({ phase: 'error', message: 'boom' })
  })

  it('rejects after timeoutMs naming the last observed phase, and a late record does not leak', async () => {
    vi.useFakeTimers()
    const store = createSessionStatusStore()
    store.record({ status: 'compiling', message: '' })

    const settled = store.waitForSettled({ afterGeneration: 1, timeoutMs: 5000 })
    const outcome = expect(settled).rejects.toThrow(/timed out after 5000ms.*compiling/s)
    vi.advanceTimersByTime(5000)
    await outcome

    // The timed-out waiter is removed: a later record must not throw or
    // double-settle anything.
    expect(() => store.record({ status: 'ready', message: '' })).not.toThrow()
  })

  it('resolving a waiter removes it (no double delivery on later records)', async () => {
    const store = createSessionStatusStore()
    const settled = store.waitForSettled({ afterGeneration: 0, timeoutMs: 1000 })
    store.record({ status: 'ready', message: 'first' })
    const first = await settled
    store.record({ status: 'ready', message: 'second' })
    // The resolved promise keeps its original snapshot.
    expect(first.message).toBe('first')
  })
})
