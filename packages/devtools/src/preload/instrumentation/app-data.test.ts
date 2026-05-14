import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BridgeChannel, SimulatorChannel } from '../../shared/ipc-channels'

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

import { ipcRenderer } from 'electron'
import { installAppDataInstrumentation } from './app-data'

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
let dispose: (() => void) | null = null

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

describe('installAppDataInstrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalWorker = (window as any).Worker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Worker = StubWorker as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Worker = StubWorker as any
  })

  afterEach(() => {
    if (dispose) {
      try { dispose() } catch { /* ignore */ }
      dispose = null
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Worker = originalWorker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Worker = originalWorker
  })

  // ── C1: install replaces Worker; messages produce one IPC call per update ──
  describe('C1: emits one IPC message per update entry', () => {
    it('replaces window.Worker after installation', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = (window as any).Worker
      dispose = installAppDataInstrumentation()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const after = (window as any).Worker
      expect(after).not.toBe(before)
    })

    it('emits SimulatorChannel.AppData with {bridgeId, moduleId, data} for a single update', () => {
      dispose = installAppDataInstrumentation()
      // R6: seed an init so the subsequent ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      vi.clearAllMocks()
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      )
    })

    it('emits once per update entry when multiple updates arrive in one message', () => {
      dispose = installAppDataInstrumentation()
      // R6: seed inits for each moduleId so the multi-update ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))
      vi.clearAllMocks()
      fireMessage(
        makePublish('b1', [
          { moduleId: 'page_m1', data: { a: 1 } },
          { moduleId: 'page_m2', data: { b: 2 } },
        ]),
      )

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(2)
      expect(ipcRenderer.sendToHost).toHaveBeenNthCalledWith(
        1,
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { a: 1 } },
      )
      expect(ipcRenderer.sendToHost).toHaveBeenNthCalledWith(
        2,
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m2', componentPath: '/p2', data: { b: 2 } },
      )
    })
  })

  // ── C2: event.data may arrive as parsed object OR JSON string ───────────
  describe('C2: accepts event.data as object or JSON string', () => {
    it('handles event.data as a parsed object', () => {
      dispose = installAppDataInstrumentation()
      // R6: seed an init so the subsequent ub is not dropped.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      vi.clearAllMocks()
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      )
    })

    it('handles event.data as a JSON string of the same shape', () => {
      dispose = installAppDataInstrumentation()
      // R6: seed an init (object form) before sending the JSON-string ub.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      vi.clearAllMocks()
      const payload = makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }])
      fireMessage(JSON.stringify(payload))

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      )
    })
  })

  // ── C3: patches accumulate per (bridgeId, moduleId) ─────────────────────
  describe('C3: accumulates patches per (bridgeId, moduleId)', () => {
    it('merges later patches into the previously-seen state', () => {
      dispose = installAppDataInstrumentation()

      // R6: seed an init; clear mocks so the ub emissions start at index 0.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      vi.clearAllMocks()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { bar: 2 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 9 } }]))

      // 3 emissions in order, each carrying the merged state (componentPath
      // persists from the seeded init).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(3)
      expect(calls[0]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      ])
      expect(calls[1]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1, bar: 2 } },
      ])
      expect(calls[2]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 9, bar: 2 } },
      ])
    })
  })

  // ── C4: independent accumulation per (bridgeId, moduleId) tuple ─────────
  describe('C4: state is per-(bridgeId, moduleId), no cross-bleed', () => {
    it('different moduleIds on the same bridge stay isolated', () => {
      dispose = installAppDataInstrumentation()

      // R6: seed inits for both modules on b1.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))
      vi.clearAllMocks()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m2', data: { bar: 2 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      ])
      // page_m2's data must NOT include page_m1's `foo: 1`.
      expect(calls[1]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m2', componentPath: '/p2', data: { bar: 2 } },
      ])
    })

    it('same moduleId on different bridges stays isolated', () => {
      dispose = installAppDataInstrumentation()

      // R6: seed inits for both bridges (same moduleId is fine).
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m1', 'b2', '/p2', {}))
      vi.clearAllMocks()

      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]))
      fireMessage(makePublish('b2', [{ moduleId: 'page_m1', data: { bar: 2 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { baz: 3 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(3)
      expect(calls[0]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1 } },
      ])
      // b2/page_m1 must NOT inherit b1/page_m1's `foo: 1`.
      expect(calls[1]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b2', moduleId: 'page_m1', componentPath: '/p2', data: { bar: 2 } },
      ])
      // b1/page_m1 keeps its own accumulated state — it should NOT see `bar: 2`.
      expect(calls[2]).toEqual([
        SimulatorChannel.AppData,
        { bridgeId: 'b1', moduleId: 'page_m1', componentPath: '/p1', data: { foo: 1, baz: 3 } },
      ])
    })
  })

  // ── C5: malformed / non-'ub' messages must be ignored ───────────────────
  describe('C5: ignores non-ub or malformed messages', () => {
    it('ignores messages whose type is not "ub"', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({
        type: 'invoke',
        target: 'render',
        method: 'publish',
        body: { bridgeId: 'b1', updates: [{ moduleId: 'm1', data: { a: 1 } }], callbackIds: [] },
      })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('ignores messages with no body', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({ type: 'ub', target: 'render', method: 'publish' })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('ignores messages whose body.updates is not an array', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({
        type: 'ub',
        target: 'render',
        method: 'publish',
        body: { bridgeId: 'b1', updates: 'nope', callbackIds: [] },
      })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('ignores update entries missing moduleId', () => {
      dispose = installAppDataInstrumentation()
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
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('ignores non-JSON string event.data', () => {
      dispose = installAppDataInstrumentation()
      fireMessage('this is not json')
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })
  })

  // ── C6: dispose restores Worker identity and stops emissions ────────────
  describe('C6: disposer restores Worker and stops emissions', () => {
    it('restores window.Worker to the original constructor identity', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = (window as any).Worker
      dispose = installAppDataInstrumentation()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).Worker).not.toBe(before)
      dispose()
      dispose = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).Worker).toBe(before)
    })

    it('stops further IPC emissions even from a worker created before dispose', () => {
      dispose = installAppDataInstrumentation()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window as any).Worker as new (
        url: string | URL,
        opts?: WorkerOptions,
      ) => EventTarget
      const w = new Ctor('worker.js')

      // R6: seed an init for b1 first so the sanity ub is not silently dropped.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makeInit('page_m1', 'b1', '/p1', {}),
        }),
      )
      vi.clearAllMocks()

      // Sanity: while installed, this would emit.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makePublish('b1', [{ moduleId: 'page_m1', data: { foo: 1 } }]),
        }),
      )
      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)

      // Now dispose.
      dispose()
      dispose = null
      vi.clearAllMocks()

      // Further messages on the same (pre-dispose) worker must NOT emit.
      w.dispatchEvent(
        new MessageEvent('message', {
          data: makePublish('b1', [{ moduleId: 'page_m1', data: { bar: 2 } }]),
        }),
      )
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })
  })

  // ── Helper: extract the listener registered for a given channel ─────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findRegisteredListener(channel: string): ((event: any) => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (ipcRenderer.on as any).mock.calls as Array<[string, (event: any) => void]>
    const found = calls.find((c) => c[0] === channel)
    if (!found) {
      throw new Error(`No ipcRenderer.on listener registered for channel ${channel}`)
    }
    return found[1]
  }

  // ── C7: renderer-initiated full snapshot refresh ────────────────────────
  describe('C7: AppDataGetAllRequest replies with full cumulative snapshot', () => {
    it('registers a host-message listener on BridgeChannel.AppDataGetAllRequest', () => {
      dispose = installAppDataInstrumentation()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.on as any).mock.calls as Array<[string, unknown]>
      expect(calls.some((c) => c[0] === BridgeChannel.AppDataGetAllRequest)).toBe(true)
    })

    it('sends the merged snapshot on SimulatorChannel.AppDataAll when the request listener fires', () => {
      dispose = installAppDataInstrumentation()

      // R6: seed inits so that subsequent ubs are accepted.
      // Init for page_m1 sets b1's pagePath to '/p1'; init for page_m2
      // accumulates onto the same bridge under its own (componentPath) key.
      fireMessage(makeInit('page_m1', 'b1', '/p1', {}))
      fireMessage(makeInit('page_m2', 'b1', '/p2', {}))
      // Clear sendToHost only — preserving ipcRenderer.on's call history so
      // findRegisteredListener can still locate the AppDataGetAllRequest
      // listener registered during install.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // Drive two worker updates so the preload accumulates state.
      fireMessage(makePublish('b1', [{ moduleId: 'page_m1', data: { a: 1 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_m2', data: { x: 9 } }]))

      // Sanity: the two per-update emissions happened.
      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(2)

      // Trigger the renderer-initiated refresh.
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // One additional sendToHost on AppDataAll carrying the full snapshot.
      // bridgePagePath is overwritten by each page_* init, so b1's pagePath
      // is '/p2' (last seeded).
      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(3)
      expect(ipcRenderer.sendToHost).toHaveBeenLastCalledWith(
        SimulatorChannel.AppDataAll,
        {
          bridges: [{ id: 'b1', pagePath: '/p2' }],
          entries: { b1: { '/p1': { a: 1 }, '/p2': { x: 9 } } },
        },
      )
    })

    it('C7: bridges list omits any bridge that only saw component messages', () => {
      dispose = installAppDataInstrumentation()

      // A bridge that only ever sees component_* messages (init + ub) must not
      // surface in the bridges list nor accumulate entries.
      fireMessage(makeInit('component_xyz', 'b9', '/components/foo/index', { ok: true }))
      fireMessage(
        makePublish('b9', [
          { moduleId: 'component_xyz', data: { more: 1 } },
        ]),
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = (ipcRenderer.sendToHost as any).mock.calls[0][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges).toEqual([])
      expect(snapshot.entries).not.toHaveProperty('b9')
    })

    it('snapshot reflects accumulated merges for the same (bridgeId, moduleId)', () => {
      dispose = installAppDataInstrumentation()

      // Seed pagePath for b1 and b2 with init messages.
      fireMessage(makeInit('page_x', 'b1', '/p1', { foo: 1 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { bar: 2 } }]))
      fireMessage(makeInit('page_y', 'b2', '/p2', { z: 7 }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppDataAll,
        {
          bridges: [
            { id: 'b1', pagePath: '/p1' },
            { id: 'b2', pagePath: '/p2' },
          ],
          entries: {
            b1: { '/p1': { foo: 1, bar: 2 } },
            b2: { '/p2': { z: 7 } },
          },
        },
      )
    })
  })

  // ── C8: disposer unregisters the AppDataGetAllRequest listener ──────────
  describe('C8: disposer unregisters the AppDataGetAllRequest listener', () => {
    it('calls ipcRenderer.removeListener with the same (channel, listener) pair', () => {
      dispose = installAppDataInstrumentation()
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)

      dispose()
      dispose = null

      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
        BridgeChannel.AppDataGetAllRequest,
        listener,
      )
    })

    it('no further sendToHost occurs when the captured listener fires after dispose', () => {
      dispose = installAppDataInstrumentation()

      // Seed some state so a snapshot reply would be non-empty if it leaked.
      fireMessage(makePublish('b1', [{ moduleId: 'm1', data: { a: 1 } }]))

      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)

      dispose()
      dispose = null

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // Simulate a stray renderer request arriving after dispose.
      listener(undefined)

      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })
  })

  // ── Helpers used by C9–C13 ──────────────────────────────────────────────
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

  // ── C9: init message (page_* / component_*) emits one IPC with path ─────
  describe('C9: init message → single IPC emit with componentPath', () => {
    it('emits one AppData call with componentPath for a page_<uuid> init (object form)', () => {
      dispose = installAppDataInstrumentation()
      fireMessage(makeInit('page_abc', 'b1', '/pages/index/index', { n: 0, list: ['a'] }))

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppData,
        {
          bridgeId: 'b1',
          moduleId: 'page_abc',
          componentPath: '/pages/index/index',
          data: { n: 0, list: ['a'] },
        },
      )
    })

    it('emits one AppData call with componentPath for a page_<uuid> init (JSON string form)', () => {
      dispose = installAppDataInstrumentation()
      const payload = makeInit('page_abc', 'b1', '/pages/index/index', { n: 0, list: ['a'] })
      fireMessage(JSON.stringify(payload))

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppData,
        {
          bridgeId: 'b1',
          moduleId: 'page_abc',
          componentPath: '/pages/index/index',
          data: { n: 0, list: ['a'] },
        },
      )
    })

    it('ignores component_* init (no IPC emission, no cache write)', () => {
      dispose = installAppDataInstrumentation()
      fireMessage(makeInit('component_xyz', 'b1', '/components/foo/index', { ok: true }))

      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('does NOT emit for messages whose type lacks page_/component_ prefix', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({
        type: 'not_a_prefix_xyz',
        body: { bridgeId: 'b1', path: '/p', data: { a: 1 } },
      })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('does NOT emit for a page_* type whose body lacks path', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({
        type: 'page_abc',
        body: { bridgeId: 'b1', data: { a: 1 } },
      })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('does NOT emit for a page_* type whose body lacks data', () => {
      dispose = installAppDataInstrumentation()
      fireMessage({
        type: 'page_abc',
        body: { bridgeId: 'b1', path: '/p' },
      })
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('C9: drops ub entries whose moduleId starts with component_', () => {
      dispose = installAppDataInstrumentation()

      // A ub message containing only component_* updates: must yield zero IPC
      // emissions AND no entry in the snapshot.
      fireMessage(
        makePublish('b1', [
          { moduleId: 'component_a', data: { foo: 1 } },
          { moduleId: 'component_b', data: { bar: 2 } },
        ]),
      )
      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()

      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls as Array<[string, unknown]>
      const allCall = calls.find((c) => c[0] === SimulatorChannel.AppDataAll)
      expect(allCall).toBeDefined()
      const snapshot = allCall![1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.entries).not.toHaveProperty('b1')
    })
  })

  // ── C10: init seeds cache; subsequent `ub` patches merge ONTO init ──────
  describe('C10: init seeds cache, subsequent ub merges onto init', () => {
    it('second emission carries fully-merged state and componentPath from init', () => {
      dispose = installAppDataInstrumentation()

      fireMessage(makeInit('page_x', 'b1', '/p', { a: 1, b: 2 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { c: 3, b: 99 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(2)

      // Second call: merged state and path preserved.
      expect(calls[1]).toEqual([
        SimulatorChannel.AppData,
        {
          bridgeId: 'b1',
          moduleId: 'page_x',
          componentPath: '/p',
          data: { a: 1, b: 99, c: 3 },
        },
      ])
    })
  })

  // ── C11: componentPath persists across subsequent ub patches ────────────
  describe('C11: componentPath persists for known (bridgeId, moduleId)', () => {
    it('every subsequent ub patch on the seeded (bridge, module) carries the init path', () => {
      dispose = installAppDataInstrumentation()

      fireMessage(makeInit('page_x', 'b1', '/p', { a: 1 }))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { b: 2 } }]))
      fireMessage(makePublish('b1', [{ moduleId: 'page_x', data: { c: 3 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(3)
      // Each call after init must carry componentPath '/p'.
      expect(calls[1][1].componentPath).toBe('/p')
      expect(calls[2][1].componentPath).toBe('/p')
    })

    it('post-init ub emissions carry the seeded componentPath', () => {
      // R6: ub-without-init is dropped, so this test now seeds an init for b2
      // and asserts that the subsequent ub picks up the seeded componentPath.
      dispose = installAppDataInstrumentation()

      fireMessage(makeInit('page_y', 'b2', '/p_y', {}))
      vi.clearAllMocks()
      fireMessage(makePublish('b2', [{ moduleId: 'page_y', data: { q: 1 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls
      expect(calls).toHaveLength(1)
      const payload = calls[0][1] as { componentPath?: unknown }
      expect(payload.componentPath).toBe('/p_y')
    })
  })

  // ── C12: pageUnload via worker.postMessage clears cache for that bridge ─
  describe('C12: pageUnload clears cache for the targeted bridge', () => {
    it('object-form pageUnload evicts b1/* but keeps b2/* and forwards to original postMessage', () => {
      dispose = installAppDataInstrumentation()

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

      // Sanity: two AppData emissions happened.
      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(2)

      // Drive main → worker pageUnload for bridge b1.
      w1.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      // Transparent forwarding: original postMessage was invoked.
      // The wrapper may have replaced the property, but `originalPostMessage`
      // (a vi.fn) must have been called at least once.
      expect(originalPostMessage).toHaveBeenCalled()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // Trigger snapshot.
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshotCall = (ipcRenderer.sendToHost as any).mock.calls[0]
      expect(snapshotCall[0]).toBe(SimulatorChannel.AppDataAll)
      const snapshot = snapshotCall[1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }

      // b1 must be gone from both bridges list and entries.
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      // b2 must still be present with its pagePath, and entries.b2['/p2'] equals {b:2}.
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('JSON-string-form pageUnload also evicts the targeted bridge', () => {
      dispose = installAppDataInstrumentation()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      w.postMessage(JSON.stringify({ type: 'pageUnload', body: { bridgeId: 'b1' } }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = (ipcRenderer.sendToHost as any).mock.calls[0][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('non-pageUnload outgoing messages do NOT clear cache', () => {
      dispose = installAppDataInstrumentation()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))

      // Some unrelated outgoing message.
      w.postMessage({ type: 'appShow' })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = (ipcRenderer.sendToHost as any).mock.calls[0][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      // b1/page_x must still be present (under '/p1').
      expect(snapshot.bridges).toContainEqual({ id: 'b1', pagePath: '/p1' })
      expect(snapshot.entries.b1['/p1']).toEqual({ a: 1 })
    })
  })

  // ── C13: AppDataAll snapshot key prefers componentPath, falls back to bare moduleId ──
  describe('C13: snapshot key prefers componentPath, falls back to bare moduleId within bridge', () => {
    it('uses path for init-seeded entries and bare moduleId fallback for ub-only page entries', () => {
      dispose = installAppDataInstrumentation()

      // Init seeds path '/p1' for (b1, page_x).
      fireMessage(makeInit('page_x', 'b1', '/p1', { a: 1 }))
      // Patch-only for (b1, page_y) — no path known, falls back to bare moduleId.
      fireMessage(makePublish('b1', [{ moduleId: 'page_y', data: { q: 9 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
        SimulatorChannel.AppDataAll,
        {
          bridges: [{ id: 'b1', pagePath: '/p1' }],
          entries: { b1: { '/p1': { a: 1 }, page_y: { q: 9 } } },
        },
      )
    })
  })

  // ── C14: pageUnload auto-pushes AppDataAll snapshot to host ─────────────
  describe('C14: pageUnload auto-pushes AppDataAll', () => {
    it('object-form pageUnload triggers automatic AppDataAll send without an explicit request', () => {
      dispose = installAppDataInstrumentation()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      // Clear the per-update emissions so we only see post-unload activity.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // Drive pageUnload for b1 — no AppDataGetAllRequest is fired.
      w.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls as Array<[string, unknown]>
      const allCalls = calls.filter((c) => c[0] === SimulatorChannel.AppDataAll)
      expect(allCalls.length).toBeGreaterThanOrEqual(1)

      // The most recent AppDataAll snapshot must reflect the eviction of b1.
      const snapshot = allCalls[allCalls.length - 1][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })

    it('JSON-string-form pageUnload also auto-pushes AppDataAll', () => {
      dispose = installAppDataInstrumentation()

      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))
      dispatchMessage(w, makeInit('page_y', 'b2', '/p2', { b: 2 }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      w.postMessage(JSON.stringify({ type: 'pageUnload', body: { bridgeId: 'b1' } }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (ipcRenderer.sendToHost as any).mock.calls as Array<[string, unknown]>
      const allCalls = calls.filter((c) => c[0] === SimulatorChannel.AppDataAll)
      expect(allCalls.length).toBeGreaterThanOrEqual(1)

      const snapshot = allCalls[allCalls.length - 1][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges.some((b) => b.id === 'b1')).toBe(false)
      expect(snapshot.entries).not.toHaveProperty('b1')
      expect(snapshot.bridges).toContainEqual({ id: 'b2', pagePath: '/p2' })
      expect(snapshot.entries.b2['/p2']).toEqual({ b: 2 })
    })
  })

  // ── C15: R6 — ub patches must follow an init for the same bridgeId ──────
  //
  // Rationale: on navigateBack the dimina container posts
  //   {type:'pageUnload', body:{bridgeId}}
  // to the worker BEFORE the worker's onUnload finishes. onUnload can call
  // `setData` (e.g. `stopTimer` does), which produces a late `ub` that
  // arrives at main AFTER the preload has already evicted the bridge.
  // Without R6, that late ub would register the bridge anew with no
  // pagePath, surfacing a ghost `bridge_<uuid>` tab in the panel. R6
  // requires that a ub be silently dropped unless its bridgeId has
  // previously been seen via a `page_*` init message.
  describe('C15: ub for unseen bridge is dropped', () => {
    it('drops a single-update ub for a bridgeId that never saw a page_* init', () => {
      dispose = installAppDataInstrumentation()

      fireMessage(makePublish('b_lonely', [{ moduleId: 'page_m1', data: { foo: 1 } }]))

      expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
    })

    it('drops a ub even when other bridges are known', () => {
      dispose = installAppDataInstrumentation()

      // Bridge b1 is known via a page_* init.
      fireMessage(makeInit('page_x', 'b1', '/p1', { a: 1 }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // Bridge b2 has NOT been inited — its ub must be silently dropped.
      fireMessage(makePublish('b2', [{ moduleId: 'page_y', data: { q: 1 } }]))

      // No per-update emission was produced for the dropped b2 ub.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const appDataCalls = (ipcRenderer.sendToHost as any).mock.calls.filter(
        (c: [string, unknown]) => c[0] === SimulatorChannel.AppData,
      )
      expect(appDataCalls).toHaveLength(0)

      // Snapshot must NOT include b2 in either bridges or entries.
      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCalls = (ipcRenderer.sendToHost as any).mock.calls.filter(
        (c: [string, unknown]) => c[0] === SimulatorChannel.AppDataAll,
      )
      expect(allCalls.length).toBeGreaterThanOrEqual(1)
      const snapshot = allCalls[allCalls.length - 1][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges.some((b) => b.id === 'b2')).toBe(false)
      expect(snapshot.entries.b2).toBeUndefined()
    })

    it('simulates pageUnload race: ub arriving after clearBridge is dropped', () => {
      dispose = installAppDataInstrumentation()

      // Seed b1 via a page_* init.
      const w = createInstrumentedWorker()
      dispatchMessage(w, makeInit('page_x', 'b1', '/p1', { a: 1 }))

      // Container posts pageUnload to the worker — the wrapper synchronously
      // calls clearBridge('b1') so the bridge is evicted from the cache.
      w.postMessage({ type: 'pageUnload', body: { bridgeId: 'b1' } })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ipcRenderer.sendToHost as any).mockClear()

      // A late `ub` arrives AFTER eviction. Under R6 it must be dropped:
      // no new emission, no snapshot entry, and b1 must not be resurrected
      // in the bridges list.
      dispatchMessage(w, makePublish('b1', [{ moduleId: 'page_x', data: { a: 2 } }]))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const appDataCalls = (ipcRenderer.sendToHost as any).mock.calls.filter(
        (c: [string, unknown]) => c[0] === SimulatorChannel.AppData,
      )
      expect(appDataCalls).toHaveLength(0)

      const listener = findRegisteredListener(BridgeChannel.AppDataGetAllRequest)
      listener(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCalls = (ipcRenderer.sendToHost as any).mock.calls.filter(
        (c: [string, unknown]) => c[0] === SimulatorChannel.AppDataAll,
      )
      expect(allCalls.length).toBeGreaterThanOrEqual(1)
      const snapshot = allCalls[allCalls.length - 1][1] as {
        bridges: Array<{ id: string; pagePath: string | null }>
        entries: Record<string, Record<string, unknown>>
      }
      expect(snapshot.bridges).toEqual([])
      expect(snapshot.entries).not.toHaveProperty('b1')
    })
  })
})
