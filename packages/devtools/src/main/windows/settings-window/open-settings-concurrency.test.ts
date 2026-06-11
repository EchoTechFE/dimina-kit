/**
 * Codex review MAJOR ② — `openSettingsWindow` concurrency + stale-close races.
 *
 * Today's bugs, verified against source (index.ts:43-46):
 *
 *  1. CONCURRENT OPENS: the create branch is `if (!win || win.isDestroyed())
 *     { win = await createSettingsWindow(...) }` with no in-flight guard. Two
 *     overlapping `openSettingsWindow` calls both observe `settingsWindow ===
 *     null`, both await creation, and TWO BrowserWindows are constructed; the
 *     second registration clobbers the first, orphaning a live window.
 *  2. STALE CLOSE: `wireSettingsWindowEvents(win, () => setSettingsWindow(null))`
 *     clears the reference UNCONDITIONALLY. Electron delivers 'closed'
 *     asynchronously — if window A replaced a just-destroyed window B before
 *     B's 'closed' event fired, B's late callback nulls A's registration, and
 *     the next open constructs a THIRD window while A is still alive.
 *
 * Locked contract (this file is the spec):
 *  - overlapping `openSettingsWindow` calls create exactly ONE window
 *    (creation is serialized through an in-flight promise; both callers
 *    resolve against the same window);
 *  - the 'closed' cleanup only clears the registration when the closing
 *    window IS the currently registered one — a stale window's late 'closed'
 *    must not drop a live successor (the next open reuses it, no new window);
 *  - normal close still clears the reference (next open creates afresh).
 *
 * Mock pattern follows open-settings-wiring.test.ts (per-file vi.mock,
 * hoisted stub registry), but mocks at the `./create.js` seam instead of
 * booting the whole runtime: the unit under test is exactly the open/reuse/
 * cleanup orchestration in index.ts, and the seam gives the test control over
 * creation timing (required to overlap the calls deterministically).
 *
 * RED today: the concurrency test (two windows created) and the stale-close
 * test (live window dropped, third window created).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

type AnyFn = (...args: unknown[]) => unknown

type StubWindow = {
  destroyed: boolean
  isDestroyed: () => boolean
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

const stubs = vi.hoisted(() => {
  /** Every settings window the mocked createSettingsWindow produced, in order. */
  const created: unknown[] = []
  return { created }
})

function makeStubWindow(): StubWindow {
  const listeners = new Map<string, AnyFn[]>()
  const add = (ev: string, fn: AnyFn) => {
    const arr = listeners.get(ev) ?? []
    arr.push(fn)
    listeners.set(ev, arr)
  }
  const remove = (ev: string, fn: AnyFn) => {
    const arr = listeners.get(ev) ?? []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  const win: StubWindow = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    on: vi.fn((ev: string, fn: AnyFn) => { add(ev, fn); return win }),
    once: vi.fn((ev: string, fn: AnyFn) => {
      const wrap: AnyFn = (...a) => { remove(ev, wrap); return fn(...a) }
      add(ev, wrap)
      return win
    }),
    off: vi.fn((ev: string, fn: AnyFn) => { remove(ev, fn); return win }),
    removeListener: vi.fn((ev: string, fn: AnyFn) => { remove(ev, fn); return win }),
    emit: (ev, ...args) => {
      for (const fn of [...(listeners.get(ev) ?? [])]) fn(...args)
    },
    show: vi.fn(),
    focus: vi.fn(),
  }
  return win
}

// Seam mock: index.ts awaits this — the async boundary is exactly where the
// real Electron window construction suspends, letting a second caller observe
// the not-yet-registered state. `events.js` stays REAL: the 'closed' cleanup
// wiring is part of the unit under test.
vi.mock('./create.js', () => ({
  createSettingsWindow: vi.fn(async () => {
    const win = makeStubWindow()
    stubs.created.push(win)
    return win as unknown as BrowserWindow
  }),
}))

// loadWorkbenchSettings reads app.getPath('userData') + disk; stub it so the
// suite needs no electron value imports at all (index.ts itself only imports
// the BrowserWindow TYPE).
vi.mock('../../services/settings/index.js', () => ({
  loadWorkbenchSettings: vi.fn(() => ({ stub: true })),
}))

import { openSettingsWindow, type OpenSettingsWindowDeps } from './index.js'
import { createSettingsWindow } from './create.js'

function makeDeps(): { deps: OpenSettingsWindowDeps; current: () => StubWindow | null } {
  let settingsWindow: BrowserWindow | null = null
  const notify = { workbenchSettingsInit: vi.fn() }
  const deps: OpenSettingsWindowDeps = {
    rendererDir: '/stub/renderer',
    windows: {
      mainWindow: makeStubWindow() as unknown as BrowserWindow,
      get settingsWindow() { return settingsWindow },
      setSettingsWindow(win: BrowserWindow | null) { settingsWindow = win },
    },
    notify,
  }
  return { deps, current: () => settingsWindow as unknown as StubWindow | null }
}

beforeEach(() => {
  stubs.created.length = 0
  vi.mocked(createSettingsWindow).mockClear()
})

describe('② normal close still clears the registration (GREEN pin)', () => {
  it('after the current window closes, the next open creates a fresh window', async () => {
    const { deps, current } = makeDeps()
    await openSettingsWindow(deps)
    const first = current()
    expect(first).toBeTruthy()
    expect(createSettingsWindow).toHaveBeenCalledTimes(1)

    first!.destroyed = true
    first!.emit('closed')
    expect(current(), "the closing CURRENT window must clear the registration").toBeNull()

    await openSettingsWindow(deps)
    expect(createSettingsWindow).toHaveBeenCalledTimes(2)
    expect(current()).toBe(stubs.created[1])
  })
})

describe('② concurrent opens are serialized through one in-flight creation', () => {
  it('two overlapping openSettingsWindow calls create exactly ONE window [RED today]', async () => {
    // BUG CAUGHT (today): no in-flight guard — both calls observe
    // settingsWindow === null before either registration lands, so two
    // BrowserWindows are constructed and the loser is orphaned (alive,
    // unreachable, never reused).
    const { deps, current } = makeDeps()

    const p1 = openSettingsWindow(deps)
    const p2 = openSettingsWindow(deps) // issued before p1 settles
    await Promise.all([p1, p2])

    expect(
      createSettingsWindow,
      'overlapping opens must share one in-flight creation',
    ).toHaveBeenCalledTimes(1)
    expect(stubs.created).toHaveLength(1)
    expect(current()).toBe(stubs.created[0])

    // Both callers completed against the single window: shown and pushed the
    // settings snapshot (at least once each is over-constraining; the single
    // window simply must have been shown).
    expect((stubs.created[0] as StubWindow).show).toHaveBeenCalled()

    // And a later open reuses it — the race left no half-registered state.
    await openSettingsWindow(deps)
    expect(createSettingsWindow).toHaveBeenCalledTimes(1)
  })
})

describe("② a stale window's late 'closed' must not drop a live successor", () => {
  it('old window closes late → current registration survives and is reused [RED today]', async () => {
    // BUG CAUGHT (today): the 'closed' callback nulls the registration
    // unconditionally. Electron delivers 'closed' asynchronously, so a window
    // destroyed-then-replaced fires its callback AFTER the successor is
    // registered — wiping the live window's registration and forcing the next
    // open to construct a third window while the second is still alive.
    const { deps, current } = makeDeps()

    await openSettingsWindow(deps)
    const w1 = current()!
    expect(createSettingsWindow).toHaveBeenCalledTimes(1)

    // w1's native window is gone but its 'closed' event has not been
    // delivered yet (async delivery window).
    w1.destroyed = true

    await openSettingsWindow(deps)
    const w2 = current()!
    expect(createSettingsWindow).toHaveBeenCalledTimes(2)
    expect(w2).not.toBe(w1)

    // The dead window's 'closed' finally arrives — it is NOT the current
    // registration and must not clear it.
    w1.emit('closed')
    expect(
      current(),
      "a stale window's late 'closed' must not clear the live successor's registration",
    ).toBe(w2)

    // Consequence contract: the next open REUSES w2 — no third window.
    await openSettingsWindow(deps)
    expect(
      createSettingsWindow,
      'open after the stale close must reuse the live window, not create another',
    ).toHaveBeenCalledTimes(2)
    expect(current()).toBe(w2)
    expect(w2.show.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
