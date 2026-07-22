/**
 * Behavior tests for `createOpenGatedRelay` — the generic open/close-gated
 * replay-subscription primitive shared by `createGlobalConsoleMirror` and
 * `createGlobalDiagnosticsMirror`.
 *
 * Both mirrors gate their subscription to a buffered+replayable source
 * (`ConsoleForwarder`/`DiagnosticsBus`) on whether the standalone "debug the
 * whole Electron app" window is currently open (`onHostChanged`): each open
 * re-subscribes with `{replay:true}` so history is never lost even if the
 * window is opened long after boot, and each close disposes that
 * subscription so the mirror stops consuming while the window is gone.
 *
 * On its own that replay-on-every-open design has a real, e2e-confirmed bug:
 * Chromium's own per-frame `ConsoleMessageStorage` ALSO re-delivers entries
 * that were already shown during a PREVIOUS open of the same window (it
 * isn't cleared by closing DevTools, only by navigation) — so re-running
 * `{replay:true}` on every reopen and blindly calling `inject()` for every
 * replayed entry double-injects everything that was already shown once,
 * with a fresh (wrong) timestamp on the duplicate. `createOpenGatedRelay`
 * fixes this at the primitive level: it tracks, by OBJECT REFERENCE (a
 * `WeakSet`, not content equality) and across the relay's ENTIRE lifetime
 * (not reset by open/close), which entry objects have actually been passed
 * to `inject()` at least once. A replay that re-delivers an
 * already-injected object is skipped; only entries never physically injected
 * before (e.g. ones that arrived while the window was closed) actually call
 * `inject()`. Chromium's own native re-delivery is left to show the
 * once-injected ones — that's what makes reopening not double them up.
 *
 * `inject()` itself is fallible: it wraps an async `executeJavaScript` call
 * against a possibly-destroyed or not-yet-settled target, so it reports
 * whether the entry was ACTUALLY delivered by returning (or resolving to)
 * `boolean | Promise<boolean>`. An entry may only be treated as permanently
 * injected (and skipped on every future replay) once `inject()` has
 * confirmed `true`. While an `inject()` call for an entry is outstanding, a
 * concurrent replay of the same entry must not trigger a second concurrent
 * `inject()` call for it. If `inject()` reports `false` — or its promise
 * rejects — the entry must NOT be marked as injected: it has to remain
 * eligible for a real retry on the next replay (e.g. the next time the
 * window reopens), otherwise a single transient failure (destroyed target,
 * not-yet-settled front-end, a rejected `executeJavaScript`) would
 * permanently black-hole that entry from ever being shown.
 *
 * No electron/console/diagnostics coupling — a generic fake `subscribe`
 * (buffer + sinks, same buffer/replay contract `ConsoleForwarder`'s test
 * fakes use) plus a generic fake `onHostChanged` controller (same shape as
 * `global-console-mirror.test.ts`'s `makeHostChangedController`) is enough,
 * since this primitive is deliberately agnostic to the entry's shape.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOpenGatedRelay } from './open-gated-relay.js'

interface FakeEntry {
  tag: string
}

/** Generic host-changed controller — same shape used by both mirror test files. */
function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: string | null) => void) => () => void
  fire: (hostWc: string | null) => void
  registerSpy: ReturnType<typeof vi.fn>
  unregisterSpy: ReturnType<typeof vi.fn>
} {
  let handler: ((hostWc: string | null) => void) | null = null
  const unregisterSpy = vi.fn()
  const registerSpy = vi.fn((h: (hostWc: string | null) => void) => {
    handler = h
    return unregisterSpy
  })
  return {
    onHostChanged: registerSpy,
    fire: (hostWc) => {
      if (!handler) throw new Error('onHostChanged handler was never registered')
      handler(hostWc)
    },
    registerSpy,
    unregisterSpy,
  }
}

/**
 * Generic buffered+replayable source — mirrors `ConsoleForwarder`/
 * `DiagnosticsBus`'s real buffer+replay contract closely enough to exercise
 * the relay: `emit()` always appends to a buffer regardless of subscribers,
 * `subscribe(sink, {replay:true})` first drains the CURRENT buffer into
 * `sink`, in order, then delivers live entries.
 */
function makeFakeSource(): {
  subscribe: (sink: (entry: FakeEntry) => void, opts: { replay: true }) => { dispose: () => void }
  emit: (entry: FakeEntry) => void
  subscribeSpy: ReturnType<typeof vi.fn>
  disposeSpies: ReturnType<typeof vi.fn>[]
} {
  const buffer: FakeEntry[] = []
  const sinks = new Set<(entry: FakeEntry) => void>()
  const disposeSpies: ReturnType<typeof vi.fn>[] = []
  const subscribeSpy = vi.fn((sink: (entry: FakeEntry) => void, opts: { replay: true }) => {
    if (opts.replay) {
      for (const entry of buffer) sink(entry)
    }
    sinks.add(sink)
    let released = false
    const disposeSpy = vi.fn(() => {
      if (released) return
      released = true
      sinks.delete(sink)
    })
    disposeSpies.push(disposeSpy)
    return { dispose: disposeSpy }
  })
  return {
    subscribe: subscribeSpy,
    emit: (entry) => {
      buffer.push(entry)
      for (const sink of [...sinks]) sink(entry)
    },
    subscribeSpy,
    disposeSpies,
  }
}

/**
 * Flushes pending microtasks (promise `.then` continuations) so assertions
 * made after resolving/rejecting a fake `inject()` promise observe the
 * relay's reaction to it, not just the raw promise settling.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('createOpenGatedRelay — installation', () => {
  it('registers an onHostChanged handler exactly once at install time, without subscribing to the source yet', () => {
    const { subscribe, subscribeSpy } = makeFakeSource()
    const { onHostChanged, registerSpy } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    createOpenGatedRelay(onHostChanged, subscribe, inject)

    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })
})

describe('createOpenGatedRelay — first open', () => {
  it('subscribes with {replay:true} and injects every buffered entry once', async () => {
    const { subscribe, subscribeSpy, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    emit({ tag: 'a' })
    emit({ tag: 'b' })
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy.mock.calls[0]?.[1]).toEqual({ replay: true })
    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[0]?.[0]).toEqual({ tag: 'a' })
    expect(inject.mock.calls[1]?.[0]).toEqual({ tag: 'b' })
  })

  it('continues injecting new live entries after the initial replay', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    emit({ tag: 'live' })
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toEqual({ tag: 'live' })
  })
})

describe('createOpenGatedRelay — the core regression: reopening never re-injects a CONFIRMED-successful entry', () => {
  it('scenario 1+2: first open injects buffered history once; closing and reopening with NO new entries injects nothing on the second replay (core bug fix)', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    // Scenario 1: window opens for the first time — buffered history is
    // injected exactly once, and inject() confirms each one succeeded.
    emit({ tag: 'history-1' })
    emit({ tag: 'history-2' })
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
    inject.mockClear()

    // Scenario 2: close, no new entries, reopen. The replay re-delivers the
    // SAME two buffered objects — under the old (pre-fix) design this would
    // call inject() for both again, producing the duplicate + fake-timestamp
    // bug. The fix must call inject() zero times here, since both were
    // already confirmed successful.
    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).not.toHaveBeenCalled()
  })

  it('scenario 3: closing, adding one new entry, then reopening injects ONLY the new entry (old ones stay silent)', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    emit({ tag: 'history-1' })
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()
    inject.mockClear()

    fire(null)
    const freshEntry = { tag: 'while-closed' }
    emit(freshEntry)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toBe(freshEntry)
  })

  it('scenario 4: across many open/close cycles with entries added at each closed interval, each entry object is injected exactly once over its whole lifetime', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    createOpenGatedRelay(onHostChanged, subscribe, inject)

    fire('host')
    fire(null)
    const entryA = { tag: 'A' }
    emit(entryA)
    fire('host')
    await flushMicrotasks()
    fire(null)
    const entryB = { tag: 'B' }
    emit(entryB)
    fire('host')
    await flushMicrotasks()
    fire(null)
    fire('host') // one more open/close/open with nothing new in between
    await flushMicrotasks()

    const injectedRefs = inject.mock.calls.map((call) => call[0])
    expect(injectedRefs.filter((e) => e === entryA)).toHaveLength(1)
    expect(injectedRefs.filter((e) => e === entryB)).toHaveLength(1)
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('scenario 5: two content-identical entries with distinct object identity are each injected once — dedup is by reference, not content', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)

    const first = { tag: 'same' }
    const second = { tag: 'same' }
    expect(first).toEqual(second)
    expect(first).not.toBe(second)

    emit(first)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()
    inject.mockClear()

    fire(null)
    emit(second)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toBe(second)
  })
})

describe('createOpenGatedRelay — inject() success/failure feedback drives retry', () => {
  it('sync inject() returning false does NOT mark the entry as injected: the next reopen retries it (core regression — early WeakSet marking silently black-holes failed injections forever)', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'target-destroyed' }
    const inject = vi.fn().mockReturnValue(false)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toBe(entry)

    // The first attempt failed (e.g. the target was already destroyed). The
    // entry must remain eligible for a real retry, not be permanently
    // black-holed by having been marked "injected" before the outcome was
    // known.
    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)
  })

  it('sync inject() returning true marks the entry as confirmed-injected: the next reopen does not call inject() again', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'ok' }
    const inject = vi.fn().mockReturnValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)

    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('inject() returning a Promise that resolves true marks the entry as confirmed-injected once resolved: the next reopen does not retry it', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'async-ok' }
    const inject = vi.fn().mockResolvedValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)

    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('inject() returning a Promise that resolves false does NOT mark the entry as injected: the next reopen retries it', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'async-fail' }
    const inject = vi.fn().mockResolvedValue(false)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)

    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)
  })

  it('inject() returning a Promise that REJECTS is treated as a failed injection (not a crash, not a silent permanent mark): the next reopen retries it, and a subsequent successful attempt then stops the retries', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'unexpected-throw' }
    const inject = vi.fn().mockRejectedValueOnce(new Error('executeJavaScript exploded')).mockResolvedValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(1)

    // First attempt rejected — must be retried, not black-holed.
    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)

    // Second attempt succeeded — now it must stick, no further retries.
    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('a still-in-flight inject() Promise is not re-invoked by a concurrent replay of the same entry; once it resolves false, a later reopen retries it', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'in-flight' }
    let resolveFirstAttempt: ((ok: boolean) => void) | undefined
    const pendingAttempt = new Promise<boolean>((resolve) => {
      resolveFirstAttempt = resolve
    })
    const inject = vi.fn()
    inject.mockReturnValueOnce(pendingAttempt)
    inject.mockReturnValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject)

    // First open starts the (still-pending) injection attempt.
    fire('host')
    await flushMicrotasks()
    expect(inject).toHaveBeenCalledTimes(1)

    // Reopening immediately, before the first inject() call has resolved,
    // replays the same buffered entry again. Because that entry's first
    // attempt is still in flight, this must NOT trigger a second concurrent
    // inject() call for the same entry.
    fire('host')
    await flushMicrotasks()
    expect(inject).toHaveBeenCalledTimes(1)

    // The in-flight attempt turns out to have failed.
    resolveFirstAttempt?.(false)
    await flushMicrotasks()

    // Since the only attempt so far failed, a later reopen must retry it —
    // proving the in-flight state was cleared cleanly rather than leaving a
    // stale "in progress" (or worse, a stale "succeeded") mark behind.
    fire(null)
    fire('host')
    await flushMicrotasks()

    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)
  })
})

describe('createOpenGatedRelay — close', () => {
  it('disposes the live subscription when the host becomes null', () => {
    const { subscribe, disposeSpies } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)
    createOpenGatedRelay(onHostChanged, subscribe, inject)

    fire('host')
    fire(null)

    expect(disposeSpies).toHaveLength(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('does not call inject for entries emitted while closed', () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)
    createOpenGatedRelay(onHostChanged, subscribe, inject)

    fire('host')
    fire(null)
    inject.mockClear()
    emit({ tag: 'while-closed' })

    expect(inject).not.toHaveBeenCalled()
  })
})

describe('createOpenGatedRelay — dispose', () => {
  it('disposes the current live subscription and unregisters the host-changed listener', () => {
    const { subscribe, disposeSpies } = makeFakeSource()
    const { onHostChanged, fire, unregisterSpy } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)
    const relay = createOpenGatedRelay(onHostChanged, subscribe, inject)

    fire('host')
    relay.dispose()

    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('dispose is safe to call when the host was never opened (no live subscription to dispose)', () => {
    const { subscribe } = makeFakeSource()
    const { onHostChanged, unregisterSpy } = makeHostChangedController()
    const inject = vi.fn().mockReturnValue(true)
    const relay = createOpenGatedRelay(onHostChanged, subscribe, inject)

    expect(() => relay.dispose()).not.toThrow()
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
  })
})
