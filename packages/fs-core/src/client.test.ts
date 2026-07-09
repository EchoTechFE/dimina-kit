/**
 * Unit tests for ProjectFsClient's writer-mode bookkeeping (`mode` / `onModeChange`).
 * `connect()` itself needs a real Worker + OPFS + navigator.locks environment (only
 * exercised by real-browser e2e probes), so these construct a bare `ProjectFsClient`
 * instance and drive its internal `_onCoreMessage` dispatcher directly with the exact
 * message shapes fs-core.worker.js sends (WELCOME / writer-granted / writer-lost / FATAL),
 * matching what a real core→client MessagePort would deliver.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProjectFsClient } from './client.js'

type Mode = 'starting' | 'writer' | 'readonly' | 'draining' | 'dead'
type CoreEvent = { type?: string; evt?: string; error?: string; mode?: Mode; readonly?: boolean; gen?: number }

/** Structural view of the internals `_onCoreMessage`/`_setMode` touch — not exposed
 * on the public `ProjectFsClient` d.ts surface, so tests reach in via this narrow cast
 * instead of `any`/`@ts-expect-error` sprinkled at every call site. */
type ClientInternals = ProjectFsClient & {
  changeCbs: Set<(evt: CoreEvent) => void>
  modeCbs: Set<(mode: Mode) => void>
  pending: Map<number, unknown>
  _mode: Mode
  _onCoreMessage(msg: CoreEvent, resolveWelcome?: (w: CoreEvent) => void, rejectWelcome?: (e: Error) => void): void
  _setMode(mode: Mode): void
}

/** Builds a client instance with just the fields `_onCoreMessage`/`_setMode` touch,
 * skipping the real `connect()` (Worker/OPFS/locks) entirely. */
function makeBareClient(initialMode: Mode = 'starting'): ClientInternals {
  const c = new ProjectFsClient() as unknown as ClientInternals
  c.changeCbs = new Set()
  c.modeCbs = new Set()
  c.pending = new Map()
  c._mode = initialMode
  return c
}

describe('ProjectFsClient writer mode', () => {
  it('adopts mode from WELCOME, mirroring what connect() does post-await', () => {
    const c = makeBareClient()
    let welcome: CoreEvent | undefined
    c._onCoreMessage({ type: 'WELCOME', mode: 'writer', readonly: false }, (w) => { welcome = w })
    expect(welcome?.mode).toBe('writer')
    // connect() does: c._setMode(c.welcome.mode || (c.welcome.readonly ? 'readonly' : 'writer'))
    c._setMode(welcome!.mode || (welcome!.readonly ? 'readonly' : 'writer'))
    expect(c.mode).toBe('writer')
  })

  it('writer-granted flips mode to writer and notifies onModeChange subscribers', () => {
    const c = makeBareClient('readonly')
    const cb = vi.fn()
    const unsubscribe = c.onModeChange(cb)

    c._onCoreMessage({ evt: 'writer-granted', gen: 5 })

    expect(c.mode).toBe('writer')
    expect(cb).toHaveBeenCalledWith('writer')
    expect(cb).toHaveBeenCalledTimes(1)

    unsubscribe()
    c._onCoreMessage({ evt: 'writer-lost', gen: 6 })
    expect(cb).toHaveBeenCalledTimes(1) // unsubscribed — no further calls
  })

  it('writer-lost flips mode to readonly', () => {
    const c = makeBareClient('writer')
    const cb = vi.fn()
    c.onModeChange(cb)

    c._onCoreMessage({ evt: 'writer-lost', gen: 6 })

    expect(c.mode).toBe('readonly')
    expect(cb).toHaveBeenCalledWith('readonly')
  })

  it('does not notify subscribers when the mode is unchanged', () => {
    const c = makeBareClient('writer')
    const cb = vi.fn()
    c.onModeChange(cb)

    c._onCoreMessage({ evt: 'writer-granted', gen: 7 }) // already writer — no-op transition

    expect(c.mode).toBe('writer')
    expect(cb).not.toHaveBeenCalled()
  })

  it('FATAL flips mode to dead', () => {
    const c = makeBareClient('writer')
    const cb = vi.fn()
    c.onModeChange(cb)

    // mirrors self.postMessage({type:'FATAL', error}) in the worker
    c._onCoreMessage({ type: 'FATAL', error: 'boom' })

    expect(c.mode).toBe('dead')
    expect(cb).toHaveBeenCalledWith('dead')
  })

  it('still delivers evt messages to onChange subscribers alongside mode updates', () => {
    const c = makeBareClient('readonly')
    const changeCb = vi.fn()
    c.onChange(changeCb)

    const msg: CoreEvent = { evt: 'writer-granted', gen: 9 }
    c._onCoreMessage(msg)

    expect(changeCb).toHaveBeenCalledWith(msg)
    expect(c.mode).toBe('writer')
  })
})
