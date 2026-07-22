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
import { describe, expect, it } from 'vitest'
import { buildConsoleFilterScript, DEFAULT_INTERNAL_LOG_FILTER } from './console-filter.js'

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
