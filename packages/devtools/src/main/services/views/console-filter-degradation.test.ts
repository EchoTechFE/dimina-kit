/**
 * What `buildInternalLogHideScript()`'s generated source does when the front
 * end is NOT the tidy, fully built panel the happy path assumes — covered
 * separately from console-filter.test.ts, which covers what the installed hook
 * does once it is in place.
 *
 * The contracts these tests guard:
 * - **Never construct the panel too early.** `Console.ConsoleView.instance()`
 *   must stay untouched until the bootstrap probe reports ready; constructing
 *   it early strands the front-end bootstrap for good.
 * - **Retry what can still succeed, once.** A panel that has not appeared yet
 *   is worth polling for, within a bound; a front end whose ConsoleFilter has
 *   no `shouldBeVisible` at all has moved on and no amount of retrying helps.
 * - **Say which half failed.** Installing the hook and re-judging the rows
 *   already on screen are separate outcomes, and a warning that blurs them
 *   sends the next reader looking for a filter that is in fact working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInternalLogHideScript } from './console-filter.js'
import {
  createConsoleFilterClass,
  createConsoleFilterClassWithoutHook,
  createConsoleView,
  createGlobalThis,
  createReadyEui,
  createViewMessage,
  recordWarnings,
  run,
} from './console-filter-test-fixtures.js'

let warnings: { messages: string[] }

beforeEach(() => {
  vi.useFakeTimers()
  warnings = recordWarnings()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * `Console.ConsoleView.instance()` constructs the panel singleton on first
 * call. Calling it before the front end has bootstrapped kills the bootstrap
 * for good (no tabs at all), so every attempt must clear the probe first.
 */
describe('bootstrap ordering', () => {
  it('never calls Console.ConsoleView.instance() while the bootstrap probe throws', () => {
    const instance = vi.fn(() => ({ filter: null }))
    const fakeGlobalThis = {
      EUI: { ShortcutRegistry: { ShortcutRegistry: { instance: () => { throw new Error('bootstrap not ready') } } } },
      Console: { ConsoleView: { instance } },
    }

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.advanceTimersByTime(1000)

    expect(instance).not.toHaveBeenCalled()
  })

  it('never calls Console.ConsoleView.instance() while EUI does not exist yet', () => {
    const instance = vi.fn(() => ({ filter: null }))
    const fakeGlobalThis = { Console: { ConsoleView: { instance } } }

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.advanceTimersByTime(1000)

    expect(instance).not.toHaveBeenCalled()
  })

  it('finishes the installation on a later retry once the probe starts reporting ready', () => {
    let bootstrapped = false
    const filterClass = createConsoleFilterClass()
    const instance = filterClass.newInstance()
    const panel = createConsoleView(instance)
    const fakeGlobalThis: Record<string, unknown> = {
      Console: { ConsoleView: { instance: () => panel.view } },
    }
    Object.defineProperty(fakeGlobalThis, 'EUI', {
      get: () => (bootstrapped ? createReadyEui() : undefined),
    })

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.advanceTimersByTime(200)
    expect(filterClass.prototype.shouldBeVisible).toBe(filterClass.original)

    bootstrapped = true
    vi.advanceTimersByTime(2000)

    expect(filterClass.prototype.shouldBeVisible).not.toBe(filterClass.original)
    const hook = filterClass.prototype.shouldBeVisible!
    expect(hook.call(instance, createViewMessage('[service] boot'))).toBe(false)
  })
})

/**
 * The Console panel may not exist yet when injection happens: `Console` is
 * absent, or `ConsoleView.instance()` throws mid-construction.
 */
describe('a Console panel that shows up late', () => {
  it('retries until Console.ConsoleView becomes usable, then installs', () => {
    const filterClass = createConsoleFilterClass()
    const instance = filterClass.newInstance()
    const panel = createConsoleView(instance)
    let panelExists = false
    const fakeGlobalThis: Record<string, unknown> = { EUI: createReadyEui() }
    Object.defineProperty(fakeGlobalThis, 'Console', {
      get: () => (panelExists ? { ConsoleView: { instance: () => panel.view } } : undefined),
    })

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.advanceTimersByTime(200)
    expect(filterClass.prototype.shouldBeVisible).toBe(filterClass.original)

    panelExists = true
    vi.advanceTimersByTime(2000)

    expect(filterClass.prototype.shouldBeVisible).not.toBe(filterClass.original)
    expect(panel.onFilterChanged).toHaveBeenCalledTimes(1)
  })

  it('retries when ConsoleView.instance() throws mid-construction, then installs once it stops throwing', () => {
    const filterClass = createConsoleFilterClass()
    const instance = filterClass.newInstance()
    const panel = createConsoleView(instance)
    let constructed = false
    const fakeGlobalThis = {
      EUI: createReadyEui(),
      Console: {
        ConsoleView: {
          instance: () => {
            if (!constructed) throw new Error('ConsoleView is still constructing')
            return panel.view
          },
        },
      },
    }

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.advanceTimersByTime(200)
    expect(filterClass.prototype.shouldBeVisible).toBe(filterClass.original)

    constructed = true
    vi.advanceTimersByTime(2000)

    expect(filterClass.prototype.shouldBeVisible).not.toBe(filterClass.original)
  })

  it('gives up after a bounded number of retries and warns instead of polling forever', () => {
    // Retries are scheduled through the ambient `setTimeout`, not
    // `globalThis.setTimeout` — `globalThis` inside the script is the fake.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fakeGlobalThis = { EUI: createReadyEui() }

    run(buildInternalLogHideScript(), fakeGlobalThis)
    vi.runAllTimers()

    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    expect(setTimeoutSpy.mock.calls.length).toBeLessThan(200)
    expect(warnings.messages).not.toHaveLength(0)
  })
})

/**
 * A ConsoleFilter without `shouldBeVisible` on its prototype means the
 * front-end API this hook is built on has moved. Retrying cannot fix that, so
 * it must report once and stop rather than burn a full retry budget.
 */
describe('a ConsoleFilter with no shouldBeVisible to wrap', () => {
  it('warns once and stops, scheduling no retry', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const filterClass = createConsoleFilterClassWithoutHook()
    const panel = createConsoleView(filterClass.newInstance())

    run(buildInternalLogHideScript(), createGlobalThis(panel.view))
    const scheduledRightAfterTheFailedAttempt = setTimeoutSpy.mock.calls.length
    vi.runAllTimers()

    expect(scheduledRightAfterTheFailedAttempt).toBe(0)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(warnings.messages).toHaveLength(1)
  })
})

/**
 * Installing the hook and refreshing the rows already on screen are two
 * separate outcomes. A panel whose refresh entry point keeps throwing still
 * gets every FUTURE internal line hidden — reporting that as a flat "gave up"
 * would send the next reader hunting for a filter that is in fact working.
 */
describe('a panel that cannot refresh what it already rendered', () => {
  function installAgainstAPanelThatCannotRefresh() {
    const filterClass = createConsoleFilterClass()
    const view = {
      filter: {
        currentFilter: filterClass.newInstance(),
        textFilterUI: { value: () => '', setValue: vi.fn() },
      },
      onFilterChanged: vi.fn(() => { throw new Error('refresh is broken') }),
    }
    run(buildInternalLogHideScript(), createGlobalThis(view))
    vi.runAllTimers()
    return filterClass
  }

  it('still hides internal logs logged from now on', () => {
    const filterClass = installAgainstAPanelThatCannotRefresh()

    expect(filterClass.newInstance().shouldBeVisible(createViewMessage('[service] later line'))).toBe(false)
  })

  it('says the wrapper is in place and only the refresh failed', () => {
    installAgainstAPanelThatCannotRefresh()

    expect(warnings.messages.some((m) => m.includes('hidden from here on'))).toBe(true)
    expect(warnings.messages.some((m) => m.includes('gave up hiding internal logs'))).toBe(false)
  })
})
