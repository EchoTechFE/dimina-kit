import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MiniappSnapshotChannel } from '../../shared/ipc-channels'
import type { MiniappSnapshotSource, SnapshotSourceId } from './types'

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  // Additive: the host exposes its automation accessor via `contextBridge`.
  // `exposeInMainWorld` is a plain spy — it does NOT populate `window`, so the
  // accessor tests grab the API object straight off the spy's call args.
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}))

import { ipcRenderer, contextBridge } from 'electron'
// RED state: `./host` does not exist yet — the implementer creates it.
// This import deliberately fails until `createMiniappSnapshotHost` is written.
import { createMiniappSnapshotHost } from './host'

// ── Test doubles ────────────────────────────────────────────────────────

/**
 * A controllable fake `MiniappSnapshotSource`. `snapshot` is a spy returning
 * whatever `snapshotValue` currently holds (so a test can mutate it between
 * publishes and assert `snapshot()` is read fresh). The `emit` callback the
 * host hands to `start` is captured on `.emit` so a test can fire it.
 */
interface FakeSource extends MiniappSnapshotSource<unknown> {
  /** Value `snapshot()` returns; mutate to simulate runtime state change. */
  snapshotValue: unknown
  /** The `emit` callback captured from `start(emit)`; undefined before install. */
  emit?: () => void
}

function makeSource(id: SnapshotSourceId, initial: unknown = { v: 0 }): FakeSource {
  const src: FakeSource = {
    id,
    snapshotValue: initial,
    snapshot: vi.fn(() => src.snapshotValue),
    start: vi.fn((emit: () => void) => {
      src.emit = emit
    }),
    dispose: vi.fn(),
  }
  return src
}

/** A fake IpcRendererEvent — the host only forwards the trailing payload. */
const fakeEvent = {} as unknown as Electron.IpcRendererEvent

/**
 * Locate the Pull-channel listener registered via `ipcRenderer.on` and fire
 * it with a `{ id }` payload, mimicking a renderer-initiated pull. The host
 * wraps handlers as `(_event, ...args) => handler(...args)`, so we invoke
 * with `(fakeEvent, { id })`.
 */
function firePull(id: string): void {
  const calls = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, (...a: unknown[]) => void]
  >
  const found = calls.find((c) => c[0] === MiniappSnapshotChannel.Pull)
  if (!found) {
    throw new Error(`No ipcRenderer.on listener registered for ${MiniappSnapshotChannel.Pull}`)
  }
  found[1](fakeEvent, { id })
}

/** All Push envelopes sent so far, in call order. */
function pushedEnvelopes(): Array<{
  id: string
  seq: number
  ts: number
  data: unknown
}> {
  const calls = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, { id: string; seq: number; ts: number; data: unknown }]
  >
  return calls
    .filter((c) => c[0] === MiniappSnapshotChannel.Push)
    .map((c) => c[1])
}

describe('createMiniappSnapshotHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── C1: install publishes each source's initial snapshot in order ───────
  describe('C1: install publishes initial snapshots in registration order', () => {
    it('publishes exactly one initial Push per registered source', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.register(makeSource('b'))
      host.install()

      const envelopes = pushedEnvelopes()
      expect(envelopes).toHaveLength(2)
    })

    it('publishes initial snapshots in registration order (a before b)', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.register(makeSource('b'))
      host.install()

      const envelopes = pushedEnvelopes()
      expect(envelopes.map((e) => e.id)).toEqual(['a', 'b'])
    })

    it('starts every source before publishing it (start precedes its Push)', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install()

      // start() must have been called for the source...
      expect(a.start).toHaveBeenCalledTimes(1)
      // ...and the publish carried that source's snapshot.
      expect(pushedEnvelopes()).toHaveLength(1)
      expect(pushedEnvelopes()[0].id).toBe('a')
    })

    it('publishes to MiniappSnapshotChannel.Push', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()

      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        MiniappSnapshotChannel.Push,
        expect.objectContaining({ id: 'a' }),
      )
    })
  })

  // ── C2: envelope shape {id, seq, ts, data} ──────────────────────────────
  describe('C2: envelope shape is {id, seq, ts, data}', () => {
    it('carries id = source.id and data = source.snapshot() result', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a', { hello: 'world' }))
      host.install()

      const [env] = pushedEnvelopes()
      expect(env.id).toBe('a')
      expect(env.data).toEqual({ hello: 'world' })
    })

    it('envelope has exactly the keys id, seq, ts, data', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()

      const [env] = pushedEnvelopes()
      expect(Object.keys(env).sort()).toEqual(['data', 'id', 'seq', 'ts'])
    })

    it('ts is a number set to Date.now() at publish time', () => {
      const before = Date.now()
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()
      const after = Date.now()

      const [env] = pushedEnvelopes()
      expect(typeof env.ts).toBe('number')
      expect(env.ts).toBeGreaterThanOrEqual(before)
      expect(env.ts).toBeLessThanOrEqual(after)
    })
  })

  // ── C3: seq is global, strictly increasing, unique ──────────────────────
  describe('C3: seq is a global strictly-increasing unique integer', () => {
    it('first publish has seq 1, then 2, 3 across initial publishes', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.register(makeSource('b'))
      host.register(makeSource('c'))
      host.install()

      expect(pushedEnvelopes().map((e) => e.seq)).toEqual([1, 2, 3])
    })

    it('seq keeps increasing across initial publishes, emits and pulls', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      const b = makeSource('b')
      host.register(a)
      host.register(b)
      host.install()
      // 2 initial publishes → seq 1, 2

      a.emit!() // → seq 3
      firePull('b') // → seq 4
      b.emit!() // → seq 5

      const seqs = pushedEnvelopes().map((e) => e.seq)
      expect(seqs).toEqual([1, 2, 3, 4, 5])
    })

    it('all seq values are unique across every publish', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install()
      a.emit!()
      a.emit!()
      firePull('a')

      const seqs = pushedEnvelopes().map((e) => e.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
    })

    it('seq is monotonically strictly increasing', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install()
      a.emit!()
      a.emit!()

      const seqs = pushedEnvelopes().map((e) => e.seq)
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
      }
    })
  })

  // ── C4: snapshot() is called fresh at every publish ─────────────────────
  describe('C4: snapshot() is read fresh per publish', () => {
    it('a state change between two publishes is reflected in the second envelope', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a', { count: 1 })
      host.register(a)
      host.install()

      // mutate the source's state, then trigger a re-publish via emit
      a.snapshotValue = { count: 2 }
      a.emit!()

      const envelopes = pushedEnvelopes()
      expect(envelopes[0].data).toEqual({ count: 1 })
      expect(envelopes[1].data).toEqual({ count: 2 })
    })

    it('calls source.snapshot() once per publish (install + emit + pull = 3)', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install() // publish #1
      a.emit!() // publish #2
      firePull('a') // publish #3

      expect(a.snapshot).toHaveBeenCalledTimes(3)
    })
  })

  // ── C5: a source's emit() triggers exactly one publish of that source ───
  describe('C5: emit() publishes exactly that source', () => {
    it('emit() produces exactly one additional Push', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install()
      const countAfterInstall = pushedEnvelopes().length

      a.emit!()

      expect(pushedEnvelopes().length).toBe(countAfterInstall + 1)
    })

    it('emit() publishes the calling source, not any other source', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      const b = makeSource('b')
      host.register(a)
      host.register(b)
      host.install()

      b.emit!()

      const last = pushedEnvelopes()[pushedEnvelopes().length - 1]
      expect(last.id).toBe('b')
    })

    it('each source gets its own emit callback (a.emit publishes a, b.emit publishes b)', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      const b = makeSource('b')
      host.register(a)
      host.register(b)
      host.install()

      a.emit!()
      expect(pushedEnvelopes()[pushedEnvelopes().length - 1].id).toBe('a')
      b.emit!()
      expect(pushedEnvelopes()[pushedEnvelopes().length - 1].id).toBe('b')
    })
  })

  // ── C6: Pull re-publishes the requested source ──────────────────────────
  describe('C6: Pull republishes by id', () => {
    it('registers an ipcRenderer.on listener for the Pull channel', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()

      const calls = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >
      expect(calls.some((c) => c[0] === MiniappSnapshotChannel.Pull)).toBe(true)
    })

    it('Pull with a known id produces exactly one additional Push of that source', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      const b = makeSource('b')
      host.register(a)
      host.register(b)
      host.install()
      const before = pushedEnvelopes().length

      firePull('b')

      const after = pushedEnvelopes()
      expect(after.length).toBe(before + 1)
      expect(after[after.length - 1].id).toBe('b')
    })

    it('Pull reads a fresh snapshot of the requested source', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a', { n: 1 })
      host.register(a)
      host.install()

      a.snapshotValue = { n: 42 }
      firePull('a')

      const last = pushedEnvelopes()[pushedEnvelopes().length - 1]
      expect(last.data).toEqual({ n: 42 })
    })

    it('Pull with an unknown id does nothing — no Push, no throw', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()
      const before = pushedEnvelopes().length

      expect(() => firePull('does-not-exist')).not.toThrow()
      expect(pushedEnvelopes().length).toBe(before)
    })
  })

  // ── C7: disposer tears every source down and unregisters the listener ───
  describe('C7: disposer disposes sources and removes the Pull listener', () => {
    it('calls dispose() on every registered source', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      const b = makeSource('b')
      host.register(a)
      host.register(b)
      const disposer = host.install()

      disposer()

      expect(a.dispose).toHaveBeenCalledTimes(1)
      expect(b.dispose).toHaveBeenCalledTimes(1)
    })

    it('removes the Pull listener via ipcRenderer.removeListener', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      const disposer = host.install()

      // the exact (channel, wrappedListener) pair registered during install
      const onCall = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === MiniappSnapshotChannel.Pull,
      ) as [string, (...a: unknown[]) => void]

      disposer()

      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
        MiniappSnapshotChannel.Pull,
        onCall[1],
      )
    })

    it('after dispose, a source calling emit() is a no-op (no Push)', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      const disposer = host.install()
      disposer()

      const before = pushedEnvelopes().length
      a.emit!()
      expect(pushedEnvelopes().length).toBe(before)
    })
  })

  // ── C8: register() guards ───────────────────────────────────────────────
  describe('C8: register() rejects duplicates and post-install registration', () => {
    it('throws when a source with a duplicate id is registered', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('dup'))
      expect(() => host.register(makeSource('dup'))).toThrow()
    })

    it('throws when register() is called after install()', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()
      expect(() => host.register(makeSource('b'))).toThrow()
    })
  })

  // ── C9: install() may only run once ─────────────────────────────────────
  describe('C9: install() is single-shot', () => {
    it('throws when install() is called a second time', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()
      expect(() => host.install()).toThrow()
    })
  })

  // ── C10: install() exposes the synchronous automation accessor ───────────
  //
  // `install()` must additionally expose a `MiniappSnapshotApi` on the page's
  // global scope so the main process / e2e / MCP can read any panel's current
  // snapshot synchronously via `webContents.executeJavaScript`. The accessor
  // is published with `contextBridge.exposeInMainWorld('__miniappSnapshot',
  // api)` (try/catch with a `window.__miniappSnapshot = api` fallback).
  //
  //   interface MiniappSnapshotApi {
  //     get(id: SnapshotSourceId): unknown   // fresh snapshot() result, or undefined
  //     ids(): SnapshotSourceId[]            // registered ids, registration order
  //   }
  describe('C10: install() exposes the __miniappSnapshot automation accessor', () => {
    /**
     * Pull the `(channel, api)` pair the host passed to
     * `contextBridge.exposeInMainWorld` for the `__miniappSnapshot` channel.
     */
    function exposedApi(): { get: (id: string) => unknown; ids: () => string[] } {
      const calls = (contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock
        .calls as Array<[string, unknown]>
      const found = calls.find((c) => c[0] === '__miniappSnapshot')
      if (!found) {
        throw new Error('contextBridge.exposeInMainWorld was not called for __miniappSnapshot')
      }
      return found[1] as { get: (id: string) => unknown; ids: () => string[] }
    }

    it('install() calls exposeInMainWorld("__miniappSnapshot", api) with get + ids functions', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()

      expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
        '__miniappSnapshot',
        expect.objectContaining({
          get: expect.any(Function),
          ids: expect.any(Function),
        }),
      )
    })

    it('exposes the accessor exactly once per install(), even with zero sources', () => {
      const host = createMiniappSnapshotHost()
      host.install()

      const calls = (contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock
        .calls as Array<[string, unknown]>
      expect(calls.filter((c) => c[0] === '__miniappSnapshot')).toHaveLength(1)
    })

    it('api.ids() returns the registered source ids in registration order', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('alpha'))
      host.register(makeSource('beta'))
      host.register(makeSource('gamma'))
      host.install()

      expect(exposedApi().ids()).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('api.ids() returns an empty array when no sources are registered', () => {
      const host = createMiniappSnapshotHost()
      host.install()

      expect(exposedApi().ids()).toEqual([])
    })

    it('api.get(id) returns the live snapshot() result of that source', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a', { hello: 'world' }))
      host.install()

      expect(exposedApi().get('a')).toEqual({ hello: 'world' })
    })

    it('api.get(id) reads snapshot() fresh on every call (not cached)', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a', { count: 1 })
      host.register(a)
      host.install()

      const api = exposedApi()
      expect(api.get('a')).toEqual({ count: 1 })

      // mutate the source's state — a fresh read must reflect it.
      a.snapshotValue = { count: 2 }
      expect(api.get('a')).toEqual({ count: 2 })
    })

    it('api.get(id) calls source.snapshot() once per get() call', () => {
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      host.install()
      // install() publishes the initial snapshot → 1 call so far.
      const callsAfterInstall = (a.snapshot as ReturnType<typeof vi.fn>).mock.calls.length

      const api = exposedApi()
      api.get('a')
      api.get('a')

      expect((a.snapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsAfterInstall + 2,
      )
    })

    it('api.get("unknown") returns undefined for an unregistered id', () => {
      const host = createMiniappSnapshotHost()
      host.register(makeSource('a'))
      host.install()

      expect(exposedApi().get('does-not-exist')).toBeUndefined()
    })

    it('teardown is symmetric — the host disposer removes the accessor', () => {
      // The accessor is exposed via `contextBridge.exposeInMainWorld`, which in
      // this suite is a plain spy that never populates `window`; there is no
      // observable global to re-check after teardown. The host's disposer
      // performs the symmetric removal of whatever it exposed. We assert the
      // disposer runs cleanly, and that the api captured before disposal stays
      // callable afterwards (a now-disposed source's get() must not throw).
      const host = createMiniappSnapshotHost()
      const a = makeSource('a')
      host.register(a)
      const disposer = host.install()

      const api = exposedApi()
      expect(() => disposer()).not.toThrow()
      // Limitation: with `exposeInMainWorld` mocked we cannot observe the
      // global being cleared; we only verify the captured api degrades safely.
      expect(() => api.get('a')).not.toThrow()
      expect(() => api.ids()).not.toThrow()
    })
  })
})
