import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The migration replaces `installAppDataInstrumentation` / `sendAllAppData`
// with a single `createAppDataSource(): MiniappSnapshotSource<AppDataSnapshot>`.
// The Worker-instrumentation / message-decoding logic is UNCHANGED by the
// migration — it is now reached through `createAppDataSource().start(emit)`
// instead of `installAppDataInstrumentation()`, and the cumulative state is
// observed via `src.snapshot()` instead of `ipcRenderer.sendToHost`. The
// source no longer touches IPC: the `miniappSnapshot` host owns push, pull and
// the install-time publish.
//
// `electron` is still mocked because `app-data.ts` imports `runtime/bridge.js`
// (the `__simulatorData` automation surface), which imports `electron`'s
// `contextBridge`. The mock only keeps that transitive import resolving — the
// source itself no longer calls `sendToHost` / `ipcRenderer.on`.
vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}))

import { createAppDataSource } from './app-data'

/**
 * Minimal constructible stand-in for the Worker constructor.
 * The instrumentation replaces window.Worker, but uses Reflect.construct
 * on the original — so this class must be a real constructible class with
 * the dispatchEvent / addEventListener surface (provided by EventTarget).
 */
class StubWorker extends EventTarget {
  public url: string | URL
  public opts?: WorkerOptions
  public postMessage = vi.fn()
  // Snapshot of the vi.fn captured at construction time so tests can still
  // assert against the pre-instrumentation spy after the instrumentation
  // wraps `postMessage`. Reading `worker.postMessage` post-install yields
  // the wrapper, not the underlying mock — use `__rawPostMessage` instead.
  public __rawPostMessage = this.postMessage
  public terminate = vi.fn()

  constructor(url: string | URL, opts?: WorkerOptions) {
    super()
    this.url = url
    this.opts = opts
  }
}

let originalWorker: typeof Worker | undefined
let src: ReturnType<typeof createAppDataSource> | null = null

/** Build a well-formed `ub` publish payload. */
function makePublish(
  bridgeId: string,
  updates: Array<{ moduleId: string; data: Record<string, unknown> }>,
  callbackIds: string[] = [],
) {
  return {
    type: 'ub',
    target: 'render',
    method: 'publish',
    body: {
      bridgeId,
      updates,
      callbackIds,
    },
  }
}

/**
 * Create a worker via the (instrumented) window.Worker constructor and
 * dispatch a `message` event with the supplied data on it.
 */
function fireMessage(data: unknown): EventTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (window as any).Worker as new (
    url: string | URL,
    opts?: WorkerOptions,
  ) => EventTarget
  const w = new Ctor('worker.js')
  w.dispatchEvent(new MessageEvent('message', { data }))
  return w
}

describe('createAppDataSource', () => {
  let emit: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.clearAllMocks()
    emit = vi.fn()
    src = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalWorker = (window as any).Worker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Worker = StubWorker as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Worker = StubWorker as any
  })

  afterEach(() => {
    if (src) {
      try { src.dispose() } catch { /* ignore */ }
      src = null
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Worker = originalWorker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Worker = originalWorker
  })

  /** Start a fresh source over the (stubbed) Worker and capture `emit`. */
  function startSource() {
    src = createAppDataSource()
    src.start(emit)
    return src
  }

  // ── C1: install replaces Worker; each update mutates the snapshot ────────
  //
  // Reframed: the per-update incremental `sendToHost(AppData, …)` is REMOVED
  // by the migration. Each accepted update now mutates the cumulative
  // `snapshot()` and triggers one `emit()` so the host can republish.
  describe('C1: each update entry mutates the snapshot and emits', () => {
    it('has id "appdata"', () => {
      expect(createAppDataSource().id).toBe('appdata')
    })

    it('replaces window.Worker after start()', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = (window as any).Worker
      startSource()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const after = (window as any).Worker
      expect(after).not.toBe(before)
    })

    it('a single update lands at snapshot.entries[bridgeId][componentPath] and emits', () => {
      startSource()
      // seed an init so the subsequent ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      emit.mockClear()
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(emit).toHaveBeenCalledTimes(1)
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1 })
    })

    it('emits once per accepted update entry when multiple updates arrive in one message', () => {
      startSource()
      // seed inits for each moduleId so the multi-update ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))
      emit.mockClear()
      fireMessage(
        makePublish('b1', [
          { moduleId: 'page_m1', data: { a: 1 } },
          { moduleId: 'page_m2', data: { b: 2 } },
        ]),
      )

      // Two accepted updates → two emits, each carrying its own merged state.
      expect(emit).toHaveBeenCalledTimes(2)
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ a: 1 })
      expect(src!.snapshot().entries.b1['/p2']).toEqual({ b: 2 })
    })
  })

  // ── C2: event.data may arrive as parsed object OR JSON string ───────────
  describe('C2: accepts event.data as object or JSON string', () => {
    it('handles event.data as a parsed object', () => {
      startSource()
      // seed an init so the subsequent ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      emit.mockClear()
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(emit).toHaveBeenCalledTimes(1)
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1 })
    })

    it('handles event.data as a JSON string of the same shape', () => {
      startSource()
      // seed an init (object form) before sending the JSON-string ub.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      emit.mockClear()
      const payload = makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }])
      fireMessage(JSON.stringify(payload))

      expect(emit).toHaveBeenCalledTimes(1)
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1 })
    })
  })

  // ── C3: patches accumulate per (bridgeId, moduleId) ─────────────────────
  describe('C3: accumulates patches per (bridgeId, moduleId)', () => {
    it('merges later patches into the previously-seen state', () => {
      startSource()

      // seed an init; clear emit so the ub emissions start at index 0.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      emit.mockClear()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1 })

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { bar: 2 } }]))
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1, bar: 2 })

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 9 } }]))
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 9, bar: 2 })

      // 3 distinct snapshot states → 3 emits, componentPath persists.
      expect(emit).toHaveBeenCalledTimes(3)
    })
  })

  // ── C4: independent accumulation per (bridgeId, moduleId) tuple ─────────
  describe('C4: state is per-(bridgeId, moduleId), no cross-bleed', () => {
    it('different moduleIds on the same bridge stay isolated', () => {
      startSource()

      // seed inits for both modules on b1.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))
      emit.mockClear()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m2', data: { bar: 2 } }]))

      expect(emit).toHaveBeenCalledTimes(2)
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1 })
      // page_m2's data must NOT include page_m1's `foo: 1`.
      expect(src!.snapshot().entries.b1['/p2']).toEqual({ bar: 2 })
    })

    it('same moduleId on different bridges stays isolated', () => {
      startSource()

      // seed inits for both bridges (same moduleId is fine).
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m1', 'b2', '/p2', {}))
      emit.mockClear()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      fireMessage(makePublish('b2', [{ moduleId: 'page_m1', data: { bar: 2 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { baz: 3 } }]))

      expect(emit).toHaveBeenCalledTimes(3)
      // b2/page_m1 must NOT inherit b1/page_m1's `foo: 1`.
      expect(src!.snapshot().entries.b2['/p2']).toEqual({ bar: 2 })
      // b1/page_m1 keeps its own accumulated state — it should NOT see `bar: 2`.
      expect(src!.snapshot().entries.b1['/p1']).toEqual({ foo: 1, baz: 3 })
    })
  })

  // ── C5: malformed / non-'ub' messages must be ignored ───────────────────
  describe('C5: ignores non-ub or malformed messages', () => {
    it('ignores messages whose type is not "ub"', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'invoke',
        target: 'render',
        method: 'publish',
        body: { bridgeId: 'b1', updates: [{ moduleId: 'm1', data: { a: 1 } }], callbackIds: [] },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('ignores messages with no body', () => {
      startSource()
      emit.mockClear()
      fireMessage({ type: 'ub', target: 'render', method: 'publish' })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('ignores messages whose body.updates is not an array', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'ub',
        target: 'render',
        method: 'publish',
        body: { bridgeId: 'b1', updates: 'nope', callbackIds: [] },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('ignores update entries missing moduleId', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'ub',
        target: 'render',
        method: 'publish',
        body: {
          bridgeId: 'b1',
          // moduleId omitted — must be dropped.
          updates: [{ data: { foo: 1 } }],
          callbackIds: [],
        },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('ignores non-JSON string event.data', () => {
      startSource()
      emit.mockClear()
      fireMessage('this is not json')
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })
  })

  // ── C6: dispose restores Worker identity and stops state changes ────────
  describe('C6: dispose restores Worker and stops state changes', () => {
    it('restores window.Worker to the original constructor identity', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = (window as any).Worker
      startSource()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).Worker).not.toBe(before)
      src!.dispose()
      src = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).Worker).toBe(before)
    })

    it('stops further emits even from a worker created before dispose', () => {
      startSource()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window as any).Worker as new (
        url: string | URL,
        opts?: WorkerOptions,
      ) => EventTarget
      const w = new Ctor('worker.js')

      // seed an init for b1 first so the sanity ub is not silently dropped.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makeInit('page_m1', 'b1', '/p1', {}),
        }),
      )
      emit.mockClear()

      // Sanity: while installed, this would emit.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]),
        }),
      )
      expect(emit).toHaveBeenCalledTimes(1)

      // Now dispose.
      src!.dispose()
      src = null
      emit.mockClear()

      // Further messages on the same (pre-dispose) worker must NOT emit.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makePublish('b1', [{ moduleId: 'page_m1', data: { bar: 2 } }]),
        }),
      )
      expect(emit).not.toHaveBeenCalled()
    })
  })

  // ── C7: snapshot() returns the full cumulative snapshot ──────────────────
  //
  // Reframed: the source no longer registers an `AppDataGetAllRequest`
  // listener — the `miniappSnapshot` host owns pull. The renderer-initiated
  // refresh is now `src.snapshot()`, which must return the correct full
  // cumulative snapshot directly.
  describe('C7: snapshot() returns the full cumulative snapshot', () => {
    it('snapshot() returns the merged cumulative state', () => {
      startSource()

      // seed inits so that subsequent ubs are accepted.
      // Init for page_m1 sets b1's pagePath to '/p1'; init for page_m2
      // accumulates onto the same bridge under its own (componentPath) key.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))

      // Drive two worker updates so the source accumulates state.
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { a: 1 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m2', data: { x: 9 } }]))

      // bridgePagePath is overwritten by each page_* init, so b1's pagePath
      // is '/p2' (last seeded).
      expect(src!.snapshot()).toEqual({
        bridges: [{ id: 'b1', pagePath: '/p2' }],
        entries: { b1: { '/p1': { a: 1 }, '/p2': { x: 9 } } },
      })
    })

    it('C7: bridges list omits any bridge that only saw component messages', () => {
      startSource()

      // A bridge that only ever sees component_* messages (init + ub) must not
      // surface in the bridges list nor accumulate entries.
      fireMessage(makeInit('component_xyz', 'b9', '/components/foo/index', { ok: true }))
      fireMessage(
        makePublish('b9', [
          { moduleId: 'component_xyz', data: { more: 1 } },
        ]),
      )

      const snapshot = src!.snapshot()
      expect(snapshot.bridges).toEqual([])
      expect(snapshot.entries).not.toHaveProperty('b9')
    })

    it('snapshot reflects accumulated merges for the same (bridgeId, moduleId)', () => {
      startSource()

      // Seed pagePath for b1 and b2 with init messages.
      fireMessage(makeInit('page_x', 'b1', '/p1', { foo: 1 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { bar: 2 } }]))
      fireMessage(makeInit('page_y', 'b2', '/p2', { z: 7 }))

      expect(src!.snapshot()).toEqual({
        bridges: [
          { id: 'b1', pagePath: '/p1' },
          { id: 'b2', pagePath: '/p2' },
        ],
        entries: {
          b1: { '/p1': { foo: 1, bar: 2 } },
          b2: { '/p2': { z: 7 } },
        },
      })
    })
  })

  // ── C8: dispose tears the source down ───────────────────────────────────
  //
  // Reframed: the source no longer registers/unregisters an
  // `AppDataGetAllRequest` listener (the host owns pull). C8 now asserts that
  // `dispose()` tears the source down — Worker restored, no emit after dispose.
  describe('C8: dispose tears the source down', () => {
    it('restores window.Worker on dispose', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = (window as any).Worker
      startSource()
      src!.dispose()
      src = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).Worker).toBe(before)
    })

    it('no further emit occurs when a worker message arrives after dispose', () => {
      startSource()

      // Seed some state so a leak would be observable.
      fireMessage(makeInit('page_x', 'b1', '/p1', { a: 1 }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window as any).Worker as new (
        url: string | URL,
        opts?: WorkerOptions,
      ) => EventTarget
      const w = new Ctor('worker.js')

      src!.dispose()
      src = null
      emit.mockClear()

      // A stray worker message after dispose must NOT emit.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makePublish('b1', [{ moduleId: 'page_x', data: { b: 2 } }]),
        }),
      )
      expect(emit).not.toHaveBeenCalled()
    })
  })

  // ── Helpers used by C9–C15 ──────────────────────────────────────────────
  /**
   * Build an init/full-state message. `type` is dynamic — e.g.
   * `page_<uuid>` or `component_<uuid>`.
   */
  function makeInit(
    type: string,
    bridgeId: string,
    path: string,
    data: Record<string, unknown>,
  ) {
    return { type, body: { bridgeId, path, data } }
  }

  /**
   * Like `fireMessage`, but returns the constructed (instrumented) worker
   * so the caller can also drive `postMessage` on it (main → worker).
   */
  function createInstrumentedWorker(): EventTarget & { postMessage: (msg: unknown) => void } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window as any).Worker as new (
      url: string | URL,
      opts?: WorkerOptions,
    ) => EventTarget & { postMessage: (msg: unknown) => void }
    return new Ctor('worker.js')
  }

  /** Dispatch a `message` event with the given data on an existing worker. */
  function dispatchMessage(w: EventTarget, data: unknown): void {
    w.dispatchEvent(new MessageEvent('message', { data }))
  }

  // ── C9: init message (page_* / component_*) → snapshot write + emit ─────
  describe('C9: init message → snapshot entry with componentPath', () => {
    it('records a page_<uuid> init under componentPath and emits (object form)', () => {
      startSource()
      emit.mockClear()
      fireMessage(makeInit('page_abc', 'b1', '/pages/index/index', { n: 0, list: ['a'] }))

      expect(emit).toHaveBeenCalledTimes(1)
      expect(src!.snapshot()).toEqual({
        bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
        entries: { b1: { '/pages/index/index': { n: 0, list: ['a'] } } },
      })
    })

    it('records a page_<uuid> init under componentPath and emits (JSON string form)', () => {
      startSource()
      emit.mockClear()
      const payload = makeInit('page_abc', 'b1', '/pages/index/index', { n: 0, list: ['a'] })
      fireMessage(JSON.stringify(payload))

      expect(emit).toHaveBeenCalledTimes(1)
      expect(src!.snapshot()).toEqual({
        bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
        entries: { b1: { '/pages/index/index': { n: 0, list: ['a'] } } },
      })
    })

    it('ignores component_* init (no emit, no snapshot write)', () => {
      startSource()
      emit.mockClear()
      fireMessage(makeInit('component_xyz', 'b1', '/components/foo/index', { ok: true }))

      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('does NOT emit for messages whose type lacks page_/component_ prefix', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'not_a_prefix_xyz',
        body: { bridgeId: 'b1', path: '/p', data: { a: 1 } },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('does NOT emit for a page_* type whose body lacks path', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'page_abc',
        body: { bridgeId: 'b1', data: { a: 1 } },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('does NOT emit for a page_* type whose body lacks data', () => {
      startSource()
      emit.mockClear()
      fireMessage({
        type: 'page_abc',
        body: { bridgeId: 'b1', path: '/p' },
      })
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('C9: drops ub entries whose moduleId starts with component_', () => {
      startSource()
      emit.mockClear()

      // A ub message containing only component_* updates: must yield zero
      // emits AND no entry in the snapshot.
      fireMessage(
        makePublish('b1', [
          { moduleId: 'component_a', data: { foo: 1 } },
          { moduleId: 'component_b', data: { bar: 2 } },
        ]),
      )
      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot().entries).not.toHaveProperty('b1')
    })
  })

  // ── C10: init seeds cache; subsequent `ub` patches merge ONTO init ──────
  describe('C10: init seeds cache, subsequent ub merges onto init', () => {
    it('snapshot carries fully-merged state and componentPath from init', () => {
      startSource()
      emit.mockClear()

      fireMessage(makeInit('page_x', 'b1', '/p', { a: 1, b: 2 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { c: 3, b: 99 } }]))

      // Two distinct snapshot states → two emits.
      expect(emit).toHaveBeenCalledTimes(2)
      // Merged state and path preserved.
      expect(src!.snapshot()).toEqual({
        bridges: [{ id: 'b1', pagePath: '/p' }],
        entries: { b1: { '/p': { a: 1, b: 99, c: 3 } } },
      })
    })
  })

  // ── C11: componentPath persists across subsequent ub patches ────────────
  describe('C11: componentPath persists for known (bridgeId, moduleId)', () => {
    it('every subsequent ub patch on the seeded (bridge, module) stays under the init path', () => {
      startSource()
      emit.mockClear()

      fireMessage(makeInit('page_x', 'b1', '/p', { a: 1 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { b: 2 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { c: 3 } }]))

      // Three distinct snapshot states → three emits.
      expect(emit).toHaveBeenCalledTimes(3)
      // Every patch stays keyed under componentPath '/p' — never the bare
      // moduleId — so componentPath persisted across both ub patches.
      const snapshot = src!.snapshot()
      expect(Object.keys(snapshot.entries.b1)).toEqual(['/p'])
      expect(snapshot.entries.b1['/p']).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('post-init ub on a freshly-started source picks up the seeded componentPath', () => {
      // ub-without-init is dropped, so this seeds an init for b2 and
      // asserts the subsequent ub lands under the seeded componentPath.
      startSource()

      fireMessage(makeInit('page_y', 'b2', '/p_y', {}))
      emit.mockClear()
      fireMessage(makePublish('b2', [{ moduleId: 'page_y', data: { q: 1 } }]))

      expect(emit).toHaveBeenCalledTimes(1)
      // The ub is keyed under the init's componentPath '/p_y', not page_y.
      expect(Object.keys(src!.snapshot().entries.b2)).toEqual(['/p_y'])
      expect(src!.snapshot().entries.b2['/p_y']).toEqual({ q: 1 })
    })
  })

  // ── C12: pageUnload via worker.postMessage evicts the bridge ────────────
  describe('C12: pageUnload evicts the targeted bridge from the snapshot', () => {
    it('object-form pageUnload evicts b1/* but keeps b2/* and forwards to original postMessage', () => {
      startSource()
      emit.mockClear()

      // Seed two bridges via init messages.
      const w1 = createInstrumentedWorker()
      // The instrumentation overwrites `w.postMessage` on the instance with
      // its wrapper. `__rawPostMessage` (set in the StubWorker class field
      // initializer) still holds the original vi.fn captured at construct
      // time, which the wrapper forwards to.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalPostMessage = (w1 as any).__rawPostMessage
      dispatchMessage(w1, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w1, makeInit('page_y', 'b2', '/p2', { b: 2 }))
      emit.mockClear()

      // Drive main → worker pageUnload for bridge b1.
      w1.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      // Eviction is a state change → emit fired.
      expect(emit).toHaveBeenCalled()

      // Transparent forwarding: original postMessage was invoked.
      // The wrapper may have replaced the property, but `originalPostMessage`
      // (a vi.fn) must have been called at least once.
      expect(originalPostMessage).toHaveBeenCalled()

      const snapshot = src!.snapshot()
      // b1 must be gone from both bridges list and entries.
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      // b2 must still be present with its pagePath, and entries.b2['/p2'] equals {b:2}.
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('JSON-string-form pageUnload also evicts the targeted bridge', () => {
      startSource()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      w.postMessage(JSON.stringify({ type: 'pageUnload', body: { bridgeId: 'b1' } }))

      const snapshot = src!.snapshot()
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('non-pageUnload outgoing messages do NOT evict the bridge', () => {
      startSource()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))

      // Some unrelated outgoing message.
      w.postMessage({ type: 'appShow' })

      const snapshot = src!.snapshot()
      // b1/page_x must still be present (under '/p1').
      expect(snapshot.bridges).toContainEqual({ id: 'b1', pagePath: '/p1' })
      expect(snapshot.entries.b1['/p1']).toEqual({ a: 1 })
    })
  })

  // ── C13: snapshot key prefers componentPath, falls back to bare moduleId ─
  describe('C13: snapshot key prefers componentPath, falls back to bare moduleId within bridge', () => {
    it('uses path for init-seeded entries and bare moduleId fallback for ub-only page entries', () => {
      startSource()

      // Init seeds path '/p1' for (b1, page_x).
      fireMessage(makeInit('page_x', 'b1', '/p1', { a: 1 }))
      // Patch-only for (b1, page_y) — no path known, falls back to bare moduleId.
      fireMessage(makePublish('b1', [{ moduleId: 'page_y', data: { q: 9 } }]))

      expect(src!.snapshot()).toEqual({
        bridges: [{ id: 'b1', pagePath: '/p1' }],
        entries: { b1: { '/p1': { a: 1 }, page_y: { q: 9 } } },
      })
    })
  })

  // ── C14: pageUnload mutates the snapshot and emits ──────────────────────
  //
  // Reframed: the migration removes the auto-push `sendToHost(AppDataAll, …)`
  // on pageUnload. Eviction now mutates `snapshot()` and triggers `emit()` so
  // the host republishes the refreshed snapshot.
  describe('C14: pageUnload mutates the snapshot and emits', () => {
    it('object-form pageUnload emits and the snapshot no longer contains b1', () => {
      startSource()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      // Clear the per-init emissions so we only see post-unload activity.
      emit.mockClear()

      // Drive pageUnload for b1.
      w.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      // The eviction is a state change → emit fired.
      expect(emit).toHaveBeenCalled()

      const snapshot = src!.snapshot()
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('JSON-string-form pageUnload also emits and evicts the bridge', () => {
      startSource()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      emit.mockClear()

      w.postMessage(JSON.stringify({ type: 'pageUnload', body: { bridgeId: 'b1' } }))

      expect(emit).toHaveBeenCalled()

      const snapshot = src!.snapshot()
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })
  })

  // ── ub patches must follow an init for the same bridgeId ───────────────
  //
  // Rationale: on navigateBack the dimina container posts
  //   {type:'pageUnload', body:{bridgeId}}
  // to the worker BEFORE the worker's onUnload finishes. onUnload can call
  // `setData` (e.g. `stopTimer` does), which produces a late `ub` that
  // arrives at main AFTER the preload has already evicted the bridge.
  // Without this gate, that late ub would register the bridge anew with no
  // pagePath, surfacing a ghost `bridge_<uuid>` tab in the panel. The gate
  // requires that a ub be silently dropped unless its bridgeId has
  // previously been seen via a `page_*` init message.
  describe('ub for unseen bridge is dropped', () => {
    it('drops a single-update ub for a bridgeId that never saw a page_* init', () => {
      startSource()
      emit.mockClear()

      fireMessage(makePublish('b_lonely', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(emit).not.toHaveBeenCalled()
      expect(src!.snapshot()).toEqual({ bridges: [], entries: {} })
    })

    it('drops a ub even when other bridges are known', () => {
      startSource()

      // Bridge b1 is known via a page_* init.
      fireMessage(makeInit('page_x', 'b1', '/p1', { a: 1 }))
      emit.mockClear()

      // Bridge b2 has NOT been inited — its ub must be silently dropped.
      fireMessage(makePublish('b2', [{ moduleId: 'page_y', data: { q: 1 } }]))

      // No state change → no emit for the dropped b2 ub.
      expect(emit).not.toHaveBeenCalled()

      // Snapshot must NOT include b2 in either bridges or entries.
      const snapshot = src!.snapshot()
      expect(snapshot.bridges.some((b) => b.id === 'b2')).toBe(false)
      expect(snapshot.entries.b2).toBeUndefined()
    })

    it('simulates pageUnload race: ub arriving after clearBridge is dropped', () => {
      startSource()

      // Seed b1 via a page_* init.
      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))

      // Container posts pageUnload to the worker — the wrapper synchronously
      // evicts b1 from the cache.
      w.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      emit.mockClear()

      // A late `ub` arrives AFTER eviction. It must be dropped:
      // no new emit, no snapshot entry, and b1 must not be resurrected
      // in the bridges list.
      dispatchMessage(w, makePublish('b1', [{ moduleId: 'page_x', data: { a: 2 } }]))

      expect(emit).not.toHaveBeenCalled()
      const snapshot = src!.snapshot()
      expect(snapshot.bridges).toEqual([])
      expect(snapshot.entries).not.toHaveProperty('b1')
    })
  })

  // C16 (install emits an empty AppDataAll snapshot) was deleted: the
  // install-time publish is now the framework host's responsibility —
  // covered by `src/preload/miniapp-snapshot/host.test.ts`.
})
