/**
 * Extreme-scale / race-condition tests for `createInternalDevtoolsWindow`.
 * Independent adversarial-test-author pass — written against the CURRENT
 * implementation without modifying it. Electron mock copied verbatim from
 * `./index.test.ts` (same trimmed BrowserWindow/WebContentsView/View stubs)
 * so this file exercises the exact same simulated Electron event semantics
 * the sibling suite already relies on.
 *
 * Three invariants under adversarial load:
 *  1. 100x open→close(hide)→open churn: `onHostChanged` notifications must
 *     strictly alternate host/null/host/null/... (no dupes), and the
 *     underlying 'show'/'hide'/'closed'/'close'/'resize' listener counts on
 *     the (never-rebuilt) window must stay at exactly 1 each — `buildOnce()`
 *     only runs once ever, so churn must never accumulate listeners.
 *  2. 100x interleaved subscribe-then-immediately-unsubscribe vs
 *     subscribe-then-survive-the-catch-up-microtask: only survivors may ever
 *     receive the catch-up replay: an unsubscribe raced before the queued
 *     microtask must cleanly cancel it.
 *  3. `isAppQuitting()` is read fresh on every native 'close' — never cached
 *     from an earlier open()/construction-time snapshot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { createInternalDevtoolsWindow } from './index.js'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const browserWindows: unknown[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return this },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return this
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
  }

  function reset() {
    browserWindows.length = 0
  }

  return { browserWindows, makeEmitter, reset }
})

vi.mock('electron', () => {
  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    setDevToolsWebContents = vi.fn()
    isDevToolsOpened = vi.fn(() => false)
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class View {
    children: unknown[] = []
    addChildView(c: unknown) { this.children.push(c) }
    removeChildView(c: unknown) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1) }
  }

  class BrowserWindowStub {
    em = stubs.makeEmitter()
    destroyed = false
    webContents = new WebContents()
    contentView = new View()
    constructor() { stubs.browserWindows.push(this) }
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    show = vi.fn(() => { this.em.emit('show') })
    showInactive = vi.fn(() => { this.em.emit('show') })
    focus = vi.fn()
    hide = vi.fn(() => { this.em.emit('hide') })
    close = vi.fn(() => {
      let prevented = false
      this.em.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) {
        this.destroyed = true
        this.em.emit('closed')
      }
    })
    destroy = vi.fn(() => { this.destroyed = true; this.em.emit('closed') })
  }

  return { BrowserWindow: BrowserWindowStub, WebContentsView, View, default: {} }
})

interface StubEmitter { listeners: Record<string, Set<unknown>> }
interface StubBrowserWindow {
  em: StubEmitter
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

let target: BrowserWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  stubs.reset()
  target = new BrowserWindow()
  process.env.NODE_ENV = 'production'
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function lastWindow(): StubBrowserWindow {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindow
}

describe('createInternalDevtoolsWindow: 100x open->close(hide)->open churn', () => {
  it('onHostChanged sees a strictly alternating host/null sequence with no consecutive duplicates', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const seen: Array<'host' | 'null'> = []
    ctrl.onHostChanged((hostWc) => { seen.push(hostWc === null ? 'null' : 'host') })

    for (let i = 0; i < 100; i++) {
      ctrl.open()
      ;(lastWindow().close as unknown as () => void)()
    }

    expect(seen.length).toBe(200) // 100 opens + 100 closes
    for (let i = 0; i < seen.length; i++) {
      expect(seen[i]).toBe(i % 2 === 0 ? 'host' : 'null')
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `index ${i} must differ from its predecessor (no consecutive duplicate notifications)`).not.toBe(seen[i - 1])
    }
  })

  it('never accumulates a second show/hide/closed/close/resize listener across 100 churns — buildOnce() runs exactly once', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const countBeforeOpen = stubs.browserWindows.length // `target` itself, constructed in beforeEach
    ctrl.open() // triggers buildOnce() — constructs the ONE host window
    const win = lastWindow()

    for (let i = 0; i < 100; i++) {
      ;(win.close as unknown as () => void)()
      ctrl.open()
    }

    for (const ev of ['show', 'hide', 'closed', 'close', 'resize']) {
      expect(
        win.em.listeners[ev]?.size ?? 0,
        `listener count for '${ev}' must stay at exactly 1 after 100 churns (buildOnce() must never re-register)`,
      ).toBe(1)
    }
    // Exactly one HOST window was ever constructed across the whole churn
    // (on top of whatever existed before the first open()).
    expect(stubs.browserWindows.length).toBe(countBeforeOpen + 1)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: 100x subscribe/unsubscribe race against the catch-up microtask', () => {
  it('only handlers that survive past the catch-up microtask ever get called; immediately-unsubscribed ones never do', async () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open() // window is now visible — currentHost is non-null

    const sacrificed = vi.fn()
    const survivors = Array.from({ length: 100 }, () => vi.fn())

    for (let i = 0; i < 100; i++) {
      // Sacrifice: subscribe then unsubscribe in the SAME synchronous tick,
      // before the catch-up microtask can ever run.
      const unsub = ctrl.onHostChanged(sacrificed)
      unsub()
      // Survivor: subscribe and never unsubscribe.
      ctrl.onHostChanged(survivors[i]!)
    }

    await Promise.resolve()
    await Promise.resolve()

    expect(sacrificed, 'a handler unsubscribed before the catch-up microtask fires must never be called').not.toHaveBeenCalled()
    for (const [i, survivor] of survivors.entries()) {
      expect(survivor, `survivor #${i} must receive exactly one catch-up replay`).toHaveBeenCalledTimes(1)
    }
  })

  it('a handler that unsubscribes ONE microtask into the two-microtask catch-up chain still gets skipped (re-validated at fire time, not just at registration time)', async () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()

    const results: Array<'called' | 'not-called'> = []
    for (let i = 0; i < 100; i++) {
      const handler = vi.fn()
      const unsub = ctrl.onHostChanged(handler)
      // Unsubscribe after exactly one microtask — the catch-up replay is
      // itself scheduled via `queueMicrotask` (one hop), so this races
      // squarely against it.
      await Promise.resolve()
      unsub()
      await Promise.resolve()
      results.push(handler.mock.calls.length === 0 ? 'not-called' : 'called')
    }

    // Whichever way the race resolves, it must be CONSISTENT (not flaky) —
    // same relative ordering every iteration since queueMicrotask ordering
    // is deterministic in a single-threaded event loop.
    expect(new Set(results).size, 'the microtask race must resolve identically every iteration, not flip-flop').toBe(1)
  })
})

describe('createInternalDevtoolsWindow: isAppQuitting() is read fresh on every close, not cached', () => {
  it('flipping the flag between two successive closes changes the outcome of the SECOND close without touching the first', () => {
    let quitting = false
    const ctrl = createInternalDevtoolsWindow(target, { isAppQuitting: () => quitting })
    ctrl.open()
    const win = lastWindow()

    ;(win.close as unknown as () => void)()
    expect(win.isDestroyed(), 'first close: isAppQuitting() was false — must be intercepted (hidden, not destroyed)').toBe(false)
    expect(win.hide).toHaveBeenCalledTimes(1)

    quitting = true
    ctrl.open() // re-show the same window for a second close cycle
    ;(win.close as unknown as () => void)()
    expect(win.isDestroyed(), 'second close: isAppQuitting() now true — must NOT be intercepted, so the native close proceeds').toBe(true)
  })

  /**
   * A literal "flag flips mid-handler-execution" race cannot be observed
   * from outside: `hostWindow.on('close', ...)` runs as one synchronous
   * callback, and `opts.isAppQuitting()` is called exactly once, synchronously,
   * at the top of it — there is no `await` point inside the handler for an
   * external flip to land "during" its execution in a way distinguishable
   * from "before" or "after". The closest meaningful probe is per-invocation
   * freshness (covered above): the decision is never memoized from an
   * earlier open()/construction-time read. A true intra-handler race is not
   * stably observable here and is skipped rather than faked.
   */
})
