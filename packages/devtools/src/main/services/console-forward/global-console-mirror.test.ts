/**
 * Behavior tests for `createGlobalConsoleMirror`.
 *
 * The standalone "debug the whole Electron app" window's subscription to the
 * shared `ConsoleForwarder` is gated by whether that window is currently
 * open — `onHostChanged` is the signal (non-null `hostWc` = just opened/
 * rebuilt, null = just closed). While open, the mirror holds a live
 * subscription made with `{replay:true}`, so opening (or reopening) the
 * window always starts by draining the forwarder's full history buffer into
 * `target`'s console. While closed, that subscription is disposed so the
 * mirror stops consuming — the `ConsoleForwarder`'s own ring buffer keeps
 * recording independently in the meantime. Reopening re-subscribes with
 * `{replay:true}` again, replaying the CURRENT buffer (including whatever
 * happened while the window was closed) — this is what actually fixes the
 * real reported bug: opening the standalone window used to show an empty
 * Console panel because the old design subscribed once at app boot, before
 * any window existed to receive the replay.
 *
 * No electron needed — a fake forwarder that mirrors `ConsoleForwarder`'s
 * real buffer+replay contract (buffer regardless of subscribers; replay
 * defaults to false, matching the real forwarder's default — see
 * `index.test.ts`) plus fake WebContents exposing `isDestroyed`/`getURL`/
 * `isLoadingMainFrame`/`executeJavaScript` (same shape used elsewhere in
 * this directory) is enough.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ConsoleForwarder, ConsoleSink, GuestConsoleEntry } from './index.js'
import { createGlobalConsoleMirror } from './global-console-mirror.js'

/**
 * `deliver()` (in `open-gated-relay.ts`) now always routes `inject()` through
 * `Promise.resolve().then(...)` — even a synchronously-successful injection —
 * so it can react to the confirmed success/failure outcome (see that
 * module's doc for why: marking "injected" before the outcome is known used
 * to permanently black-hole a failed attempt). Tests that assert on `exec`
 * having been called must flush that microtask first.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeWc(opts: { destroyed?: boolean, loading?: boolean, url?: string } = {}): { wc: WebContents, exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => opts.destroyed ?? false,
    getURL: () => opts.url ?? 'file:///main-window.html',
    isLoadingMainFrame: () => opts.loading ?? false,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec }
}

/**
 * Mirrors the real `ConsoleForwarder`'s buffer+replay contract closely
 * enough to exercise this mirror without depending on that module's own
 * implementation: `emit()` always appends to a buffer regardless of whether
 * anyone is subscribed, and `subscribe(sink, opts)` replays the current
 * buffer first when `opts.replay` is true (default false, matching the real
 * forwarder's new default — see `index.test.ts`'s replay tests).
 */
function makeFakeForwarder(): {
  forwarder: Pick<ConsoleForwarder, 'subscribe'>
  emit: (entry: GuestConsoleEntry) => void
  subscribeSpy: ReturnType<typeof vi.fn>
  disposeSpies: ReturnType<typeof vi.fn>[]
} {
  const buffer: GuestConsoleEntry[] = []
  const sinks = new Set<ConsoleSink>()
  const disposeSpies: ReturnType<typeof vi.fn>[] = []
  const subscribeSpy = vi.fn((sink: ConsoleSink, opts?: { replay?: boolean }) => {
    const replay = opts?.replay ?? false
    if (replay) {
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
    forwarder: { subscribe: subscribeSpy },
    emit: (entry) => {
      buffer.push(entry)
      for (const sink of [...sinks]) sink(entry)
    },
    subscribeSpy,
    disposeSpies,
  }
}

/** Fake `onHostChanged` registration point: models the standalone window's
 *  open/close signal (`hostWc` non-null when open/rebuilt, null when
 *  closed). */
function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void
  fire: (hostWc: WebContents | null) => void
  registerSpy: ReturnType<typeof vi.fn>
  unregisterSpy: ReturnType<typeof vi.fn>
} {
  let handler: ((hostWc: WebContents | null) => void) | null = null
  const unregisterSpy = vi.fn()
  const registerSpy = vi.fn((h: (hostWc: WebContents | null) => void) => {
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

describe('createGlobalConsoleMirror — installation', () => {
  it('registers an onHostChanged handler exactly once at install time, without subscribing to the forwarder yet (window not open)', () => {
    const { forwarder, subscribeSpy } = makeFakeForwarder()
    const { onHostChanged, registerSpy } = makeHostChangedController()
    const { wc: target } = makeWc()

    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy).not.toHaveBeenCalled()
  })
})

describe('createGlobalConsoleMirror — opening the window replays history into target (the bug fix)', () => {
  it('subscribes to the forwarder with {replay:true} exactly once when the host becomes non-null', () => {
    const { forwarder, subscribeSpy } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)

    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy.mock.calls[0]?.[1]).toEqual({ replay: true })
  })

  it('drains entries emitted BEFORE the window ever opened into target the moment it opens (core bug: history must not be lost)', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()

    // Entries happen while nobody has opened the standalone window yet —
    // e.g. framework console output at app boot.
    emit({ source: 'service', level: 'log', args: ['before window ever opened'] })
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain(JSON.stringify(JSON.stringify(['before window ever opened'])))
  })

  it('injects into `target`, not the hostWc carried by the open/close signal', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec: targetExec } = makeWc()
    const { wc: host, exec: hostExec } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'service', level: 'log', args: ['hi'] })
    await flushMicrotasks()

    expect(targetExec).toHaveBeenCalled()
    expect(hostExec).not.toHaveBeenCalled()
  })

  it('continues injecting new entries live after the initial replay', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'render', level: 'warn', args: ['live entry'] })
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain('[render]')
  })
})

describe('createGlobalConsoleMirror — closing the window pauses consumption; reopening re-replays (regression for the exact reported bug)', () => {
  it('disposes the live forwarder subscription when the host becomes null', () => {
    const { forwarder, disposeSpies } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    fire(null)

    expect(disposeSpies).toHaveLength(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('does not inject entries emitted while the window is closed', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    fire(null)
    exec.mockClear()
    emit({ source: 'service', level: 'log', args: ['during closed window'] })
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })

  it('reopening re-subscribes with {replay:true} and delivers entries that happened while the window was closed (THE bug fix)', async () => {
    const { forwarder, emit, subscribeSpy } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    fire(null)
    // This happens while the standalone window is closed. Under the old
    // one-shot-subscribe-at-boot design this entry would be permanently
    // lost to the mirror (the boot-time subscription's replay found no
    // window to inject into, and there is no second replay).
    emit({ source: 'service', level: 'error', args: ['happened while closed'] })
    exec.mockClear()

    fire(host)
    await flushMicrotasks()

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(subscribeSpy.mock.calls[1]?.[1]).toEqual({ replay: true })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain(JSON.stringify(JSON.stringify(['happened while closed'])))
  })

  it('a full close→reopen cycle never permanently drops an entry, even across multiple cycles', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'service', level: 'log', args: ['1'] })
    await flushMicrotasks()
    fire(null)
    emit({ source: 'service', level: 'log', args: ['2'] })
    fire(host)
    await flushMicrotasks()
    emit({ source: 'service', level: 'log', args: ['3'] })
    await flushMicrotasks()
    fire(null)
    emit({ source: 'service', level: 'log', args: ['4'] })
    fire(host)
    await flushMicrotasks()

    const injected = exec.mock.calls.map((call) => String(call[0]))
    for (const marker of ['1', '2', '3', '4']) {
      expect(injected.some((s) => s.includes(JSON.stringify(JSON.stringify([marker]))))).toBe(true)
    }
  })
})

describe('createGlobalConsoleMirror — reopen does not double-inject already-shown history (regression for the real reported duplicate-log bug)', () => {
  // e2e-confirmed root cause: Chromium's own per-frame ConsoleMessageStorage
  // re-delivers entries natively on reopen (it survives closing DevTools, only
  // navigation clears it) — this mirror's own {replay:true} on every reopen
  // used to ALSO re-inject the same entries, producing a visible duplicate
  // with a fresh (wrong) "reopened just now" timestamp. Entries actually
  // injected once must not be injected again by a later replay of the same
  // buffered objects; Chromium's native re-delivery is what shows them again.
  it('an entry injected during the first open is NOT re-injected when the window is closed and reopened with no new entries', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'service', level: 'log', args: ['shown once'] })
    await flushMicrotasks()
    expect(exec).toHaveBeenCalledTimes(1)
    exec.mockClear()

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })

  it('after a close, only an entry that arrived WHILE closed is injected on reopen — the pre-existing history stays silent', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'service', level: 'log', args: ['old'] })
    await flushMicrotasks()
    exec.mockClear()

    fire(null)
    emit({ source: 'service', level: 'log', args: ['new while closed'] })
    fire(host)
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain(JSON.stringify(JSON.stringify(['new while closed'])))
  })
})

describe('createGlobalConsoleMirror — settled/destroyed target gate', () => {
  it('does not inject into a destroyed target (does not throw)', () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc({ destroyed: true })
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    expect(() => emit({ source: 'service', level: 'log', args: ['x'] })).not.toThrow()

    expect(exec).not.toHaveBeenCalled()
  })

  it('does not inject into a target whose front-end has not finished loading yet (unsettled)', () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc({ loading: true, url: 'devtools://devtools/bundled/devtools_app.html' })
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    emit({ source: 'service', level: 'log', args: ['x'] })

    expect(exec).not.toHaveBeenCalled()
  })
})

describe('createGlobalConsoleMirror — dispose', () => {
  it('unregisters the host-changed listener and disposes any live forwarder subscription', () => {
    const { forwarder, disposeSpies } = makeFakeForwarder()
    const { onHostChanged, fire, unregisterSpy } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const mirror = createGlobalConsoleMirror(forwarder, target, onHostChanged)

    fire(host)
    mirror.dispose()

    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('dispose is safe to call when the window was never opened (no live subscription to dispose)', () => {
    const { forwarder } = makeFakeForwarder()
    const { onHostChanged, unregisterSpy } = makeHostChangedController()
    const { wc: target } = makeWc()
    const mirror = createGlobalConsoleMirror(forwarder, target, onHostChanged)

    expect(() => mirror.dispose()).not.toThrow()
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
  })
})
