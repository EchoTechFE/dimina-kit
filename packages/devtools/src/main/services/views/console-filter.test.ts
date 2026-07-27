/**
 * `DEFAULT_INTERNAL_LOG_FILTER` only needs to cover SERVICE-layer internal
 * log lines (`^\[service\]`) now — the render layer's framework noise
 * (own first arg `'[system]'`, forwarded into the service host's console
 * wrapped as `[视图] [system] ...` by `console-forward/index.ts`'s
 * `buildForwardScript`) is filtered at the source instead:
 * `forwardRenderToServiceHost` now gates on `isInternalLogMessage` and never
 * injects those entries at all, so they never reach the panel regardless of
 * this filter. This front-end filter is what's left for the half that has no
 * other interception point (see console-filter.ts's header comment).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConsoleFilterScript, buildLiveConsoleFilterScript, DEFAULT_INTERNAL_LOG_FILTER } from './console-filter.js'

/** Extract the regex source from DevTools' negative-filter syntax `-/regex/`. */
function extractNegativeFilterRegex(negativeFilter: string): RegExp {
  const m = /^-\/(.*)\/$/.exec(negativeFilter)
  if (!m) throw new Error(`unexpected negative-filter format: ${negativeFilter}`)
  return new RegExp(m[1])
}

describe('DEFAULT_INTERNAL_LOG_FILTER', () => {
  const regex = extractNegativeFilterRegex(DEFAULT_INTERNAL_LOG_FILTER)

  it('matches a service-layer internal log line ([service] is never wrapped)', () => {
    expect(regex.test('[service] receive msg: xxx')).toBe(true)
  })

  it('does NOT match a render-layer framework log line — that half is filtered at the source (forwardRenderToServiceHost), never reaches this filter\'s job', () => {
    expect(regex.test('[视图] [system] [render] receive msg: xxx')).toBe(false)
  })

  it('does NOT match a render-layer business log that is wrapped in [视图] but has no [system] tag right after it', () => {
    expect(regex.test('[视图] 用户自己打的业务日志')).toBe(false)
  })

  it('does NOT match an ordinary business log line with no internal-log prefix at all', () => {
    expect(regex.test('用户普通业务日志')).toBe(false)
  })
})

/**
 * Bug: the "only write when unset" logic in `buildConsoleFilterScript`
 * permanently freezes whatever default first got written — even a
 * self-authored default from an old build, once present, blocks every
 * future `DEFAULT_INTERNAL_LOG_FILTER` upgrade from ever taking effect. Fix
 * under test: a companion mark key records the value WE last wrote; the
 * injected script overwrites the main key whenever its current value still
 * equals that mark (our own stale default going out of date), and leaves it
 * alone only when it diverges from the mark (a real user customization).
 *
 * Persistence mechanism: this Global/Synced DevTools setting does NOT live
 * in `window.localStorage` — it is persisted through
 * `InspectorFrontendHost.getPreferences(callback)` (async-callback read) /
 * `InspectorFrontendHost.setPreference(key, jsonValue)` (sync write), backed
 * by the Electron host's own Preferences file. The real setting name is the
 * kebab-case `console.text-filter` (Chromium's M125+ renaming), not
 * `console.textFilter`.
 *
 * These tests execute the actual generated script string (not a
 * reimplementation of its logic) against a fake `InspectorFrontendHost`,
 * the same object the injected script talks to inside the real DevTools
 * front-end page.
 */
describe('buildConsoleFilterScript self-healing default', () => {
  const KEY = 'console.text-filter'
  const MARK_KEY = 'console.text-filter.dimina-default'

  /**
   * Fake `InspectorFrontendHost`: `getPreferences` invokes its callback
   * synchronously with a snapshot of the backing store, mirroring the real
   * host closely enough for these tests — no microtask flushing needed —
   * while still exercising the injected script's actual callback-style read.
   */
  function createFakeInspectorFrontendHost(initialPrefs: Record<string, string>) {
    const store: Record<string, string> = { ...initialPrefs }
    return {
      store,
      getPreferences(callback: (prefs: Record<string, string>) => void): void {
        callback({ ...store })
      },
      setPreference(key: string, value: string): void {
        store[key] = value
      },
    }
  }

  /** Run the generated injection script against a fresh fake `InspectorFrontendHost` seeded with `initialPrefs`. */
  function runScript(script: string, initialPrefs: Record<string, string> = {}): Record<string, string> {
    const fakeInspectorFrontendHost = createFakeInspectorFrontendHost(initialPrefs)
    const fakeGlobalThis = { InspectorFrontendHost: fakeInspectorFrontendHost }
    const run = new Function('globalThis', script)
    run(fakeGlobalThis)
    return fakeInspectorFrontendHost.store
  }

  it('first run: KEY is unset, so it writes the new default to KEY AND records it in the mark key', () => {
    const store = runScript(buildConsoleFilterScript(), {})
    expect(store[KEY]).toBe(JSON.stringify(DEFAULT_INTERNAL_LOG_FILTER))
    expect(store[MARK_KEY]).toBe(JSON.stringify(DEFAULT_INTERNAL_LOG_FILTER))
  })

  it('repeat run of a new version: KEY currently equals the mark (our own prior default), so it MUST be overwritten with the new default even though KEY is non-empty', () => {
    const staleDefault = '-/^\\[service\\]|^\\[视图\\] \\[system\\]/' // simulates an older build's DEFAULT_INTERNAL_LOG_FILTER, before render-layer filtering moved to the source and this regex shrank
    const newDefault = DEFAULT_INTERNAL_LOG_FILTER // simulates the upgraded regex shipped in this build
    const initialPrefs = {
      [KEY]: JSON.stringify(staleDefault),
      [MARK_KEY]: JSON.stringify(staleDefault),
    }

    const store = runScript(buildConsoleFilterScript(newDefault), initialPrefs)

    expect(store[KEY]).toBe(JSON.stringify(newDefault))
    expect(store[KEY]).not.toBe(JSON.stringify(staleDefault))
  })

  it('every successful default write updates the mark key to the value that was just written, so the next same-version run can recognize it', () => {
    const staleDefault = '-/^\\[service\\]|^\\[视图\\] \\[system\\]/'
    const newDefault = DEFAULT_INTERNAL_LOG_FILTER
    const initialPrefs = {
      [KEY]: JSON.stringify(staleDefault),
      [MARK_KEY]: JSON.stringify(staleDefault),
    }

    const store = runScript(buildConsoleFilterScript(newDefault), initialPrefs)

    expect(store[MARK_KEY]).toBe(JSON.stringify(newDefault))
    expect(store[MARK_KEY]).toBe(store[KEY])
  })

  it('user customization WITH a mark on record: KEY diverges from the mark, so the user value is left untouched', () => {
    const priorDefault = '-/^\\[service\\]|^\\[视图\\] \\[system\\]/'
    const userValue = '-/我自己在 DevTools 里手打的过滤规则/'
    const initialPrefs = {
      [KEY]: JSON.stringify(userValue),
      [MARK_KEY]: JSON.stringify(priorDefault),
    }

    const store = runScript(buildConsoleFilterScript(), initialPrefs)

    expect(store[KEY]).toBe(JSON.stringify(userValue))
  })

  it('user customization with NO mark on record: KEY holds a value that matches none of our known defaults, so it is left untouched (never overwritten, never treated as stale)', () => {
    const userValue = '-/pre-existing custom filter from before self-healing shipped/'
    const initialPrefs = {
      [KEY]: JSON.stringify(userValue),
    }

    const store = runScript(buildConsoleFilterScript(), initialPrefs)

    expect(store[KEY]).toBe(JSON.stringify(userValue))
  })

  it('regression: buildConsoleFilterScript() with no argument still seeds DEFAULT_INTERNAL_LOG_FILTER', () => {
    const store = runScript(buildConsoleFilterScript(), {})
    expect(store[KEY]).toBe(JSON.stringify(DEFAULT_INTERNAL_LOG_FILTER))
  })
})

/**
 * `buildLiveConsoleFilterScript` — the fix for the gap the persisted
 * preference above cannot close: a Console panel that has ALREADY
 * constructed itself (or finishes constructing shortly after injection) by
 * the time the script runs never re-reads that preference, so its live
 * filter box stays empty and framework `[service]` lines leak straight
 * through unfiltered (real repro this session). The real API this drives —
 * `Console.ConsoleView.instance().filter.textFilterUI.setValue()` +
 * `.updateCurrentFilter()` + `.onFilterChanged()` — was found via a live
 * probe against the actual bundled front-end (not guessed); see
 * console-filter.ts's doc comment.
 *
 * These tests run the actual generated script (via `new Function`) against a
 * fake `Console.ConsoleView` + `filter` object, the same technique the
 * suite above uses for the fake `InspectorFrontendHost`.
 */
describe('buildLiveConsoleFilterScript', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A fake `filter.textFilterUI` + `filter` pair mirroring the real
   * ConsoleViewFilter surface this script actually calls. */
  function createFakeFilter(initialValue = '') {
    let value = initialValue
    const updateCurrentFilter = vi.fn()
    const onFilterChanged = vi.fn()
    return {
      textFilterUI: {
        value: () => value,
        setValue: (v: string) => { value = v },
      },
      updateCurrentFilter,
      onFilterChanged,
      get value() { return value },
    }
  }

  /** A "bootstrap already finished" EUI stub: the script's in-realm probe
   * (ShortcutRegistry.instance() not throwing) must pass before it touches
   * ConsoleView at all — these tests exercise the post-probe filter flow. */
  function createReadyEui() {
    return { ShortcutRegistry: { ShortcutRegistry: { instance: () => ({}) } } }
  }

  function createFakeGlobalThis(filter: ReturnType<typeof createFakeFilter> | null) {
    return {
      EUI: createReadyEui(),
      Console: filter
        ? { ConsoleView: { instance: () => ({ filter }) } }
        : undefined,
    }
  }

  it('applies the default immediately when the live filter box is unset', () => {
    const filter = createFakeFilter('')
    const fakeGlobalThis = createFakeGlobalThis(filter)
    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)

    expect(filter.value).toBe(DEFAULT_INTERNAL_LOG_FILTER)
    expect(filter.updateCurrentFilter).toHaveBeenCalledTimes(1)
    expect(filter.onFilterChanged).toHaveBeenCalledTimes(1)
  })

  it('re-applies (idempotently) when the live filter box already equals this exact default', () => {
    const filter = createFakeFilter(DEFAULT_INTERNAL_LOG_FILTER)
    const fakeGlobalThis = createFakeGlobalThis(filter)
    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)

    expect(filter.value).toBe(DEFAULT_INTERNAL_LOG_FILTER)
    expect(filter.updateCurrentFilter).toHaveBeenCalledTimes(1)
  })

  it('does NOT overwrite a real user customization in the live filter box', () => {
    const userValue = '-/我自己手打的过滤规则/'
    const filter = createFakeFilter(userValue)
    const fakeGlobalThis = createFakeGlobalThis(filter)
    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)

    expect(filter.value).toBe(userValue)
    expect(filter.updateCurrentFilter).not.toHaveBeenCalled()
    expect(filter.onFilterChanged).not.toHaveBeenCalled()
  })

  it('retries on a bounded interval until Console.ConsoleView becomes available, then applies', () => {
    let filter: ReturnType<typeof createFakeFilter> | null = null
    const fakeGlobalThis: { EUI?: unknown; Console?: unknown } = { EUI: createReadyEui() }
    Object.defineProperty(fakeGlobalThis, 'Console', {
      get: () => (filter ? { ConsoleView: { instance: () => ({ filter }) } } : undefined),
    })

    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)

    // Not available yet — no attempt could have applied anything.
    vi.advanceTimersByTime(300)

    // ConsoleView "finishes constructing" partway through the poll window.
    filter = createFakeFilter('')
    vi.advanceTimersByTime(200)

    expect(filter.value).toBe(DEFAULT_INTERNAL_LOG_FILTER)
    expect(filter.updateCurrentFilter).toHaveBeenCalledTimes(1)
  })

  it('gives up after the bounded number of attempts if Console.ConsoleView never becomes available', () => {
    // The generated script schedules retries via the ambient `setTimeout`
    // (not `globalThis.setTimeout`) — spy on the real (fake-timer-backed)
    // global to count scheduled attempts.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fakeGlobalThis = createFakeGlobalThis(null)

    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)
    vi.runAllTimers()

    // Bounded — some finite number of scheduled retries, not an infinite loop.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    expect(setTimeoutSpy.mock.calls.length).toBeLessThan(200)
  })
})

/**
 * Every poll tick in the generated script must first check front-end
 * bootstrap readiness through the same in-realm probe
 * `frontend-bootstrap-gate.ts` exposes as `FRONTEND_BOOTSTRAP_PROBE_SCRIPT`
 * (`EUI.ShortcutRegistry.ShortcutRegistry.instance()`, wrapped in try/catch).
 * A tick that finds the probe not-yet-ready must schedule its next retry
 * WITHOUT touching `Console.ConsoleView.instance()` — an early construction
 * of that singleton is the exact bootstrap-killing failure mode
 * `frontend-bootstrap-gate.ts`'s header comment documents (an
 * `IssuesManager.instance({ensureFirst: true})` conflict that permanently
 * strands `MainImpl`'s bootstrap with no tabs at all).
 */
describe('buildLiveConsoleFilterScript gates every poll tick on the front-end bootstrap probe', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as Record<string, unknown>).EUI
  })

  it('places the ShortcutRegistry bootstrap probe ahead of the ConsoleView.instance reference in the generated script', () => {
    const script = buildLiveConsoleFilterScript()
    const probeIndex = script.indexOf('ShortcutRegistry')
    const consoleViewIndex = script.indexOf('ConsoleView.instance')

    expect(probeIndex).toBeGreaterThan(-1)
    expect(consoleViewIndex).toBeGreaterThan(-1)
    expect(probeIndex).toBeLessThan(consoleViewIndex)
  })

  it('never calls Console.ConsoleView.instance() while the bootstrap probe is not ready, and keeps retrying', () => {
    const consoleViewInstance = vi.fn(() => ({ filter: null }))
    const fakeGlobalThis = {
      EUI: { ShortcutRegistry: { ShortcutRegistry: { instance: () => { throw new Error('not ready') } } } },
      Console: { ConsoleView: { instance: consoleViewInstance } },
    }

    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)
    vi.advanceTimersByTime(1000)

    expect(consoleViewInstance).not.toHaveBeenCalled()
  })

  it('applies the filter through the existing ConsoleView flow only after the bootstrap probe reports ready', () => {
    let euiReady = false
    let filterValue = ''
    const updateCurrentFilter = vi.fn()
    const fakeFilter = {
      textFilterUI: {
        value: () => filterValue,
        setValue: (v: string) => { filterValue = v },
      },
      updateCurrentFilter,
      onFilterChanged: vi.fn(),
    }
    const fakeGlobalThis: Record<string, unknown> = {
      Console: { ConsoleView: { instance: () => ({ filter: fakeFilter }) } },
    }
    Object.defineProperty(fakeGlobalThis, 'EUI', {
      get: () => (euiReady ? { ShortcutRegistry: { ShortcutRegistry: { instance: () => ({}) } } } : undefined),
    })

    new Function('globalThis', buildLiveConsoleFilterScript())(fakeGlobalThis)
    vi.advanceTimersByTime(300)
    expect(filterValue, 'the bootstrap probe never reported ready yet, so the live filter must stay untouched').toBe('')

    euiReady = true
    vi.advanceTimersByTime(200)
    expect(filterValue).toBe(DEFAULT_INTERNAL_LOG_FILTER)
    expect(updateCurrentFilter).toHaveBeenCalledTimes(1)
  })
})
