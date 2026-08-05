/**
 * `buildInternalLogHideScript` builds the source that gets injected into the
 * right-hand Chrome DevTools front-end realm so the runtime's own `[service]`
 * log lines never show up in the Console panel.
 *
 * The contracts these tests guard, once the hook is in place:
 * - **Prototype, not instance.** The hook lands on
 *   `ConsoleFilter.prototype.shouldBeVisible`, because `clone()` mints further
 *   ConsoleFilters that judge the same messages; an instance-level hook would
 *   cover only the one instance the script happened to reach.
 * - **Only subtracts.** Internal lines are hidden; every other message gets the
 *   original filter's verdict passed through verbatim, so a developer's own
 *   filter rules keep working.
 * - **Never touches the visible filter box.** `filter.textFilterUI` belongs to
 *   the developer; hiding internal logs must not write text into it.
 * - **Installs once.** The script runs again on every re-point, and a second
 *   run must not stack a second wrapper on the first.
 *
 * What the script does when the panel is absent, still constructing, or has
 * moved on is covered in console-filter-degradation.test.ts.
 *
 * Every test drives the real generated script string through
 * `new Function('globalThis', script)` against fakes shaped like the front-end
 * objects the script talks to — never a re-implementation of its logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInternalLogHideScript, INTERNAL_LOG_HIDDEN_PREFIX } from './console-filter.js'
import {
  createConsoleFilterClass,
  createConsoleView,
  createGlobalThis,
  createViewMessage,
  recordWarnings,
  run,
  type FakeViewMessage,
  type ShouldBeVisible,
} from './console-filter-test-fixtures.js'

/** Install the hook into a front end that is ready the moment the script runs. */
function installIntoReadyPanel(options: {
  hiddenPrefix?: string
  verdict?: boolean | ShouldBeVisible
  initialFilterText?: string
} = {}) {
  const filterClass = createConsoleFilterClass(options.verdict)
  const instance = filterClass.newInstance()
  const panel = createConsoleView(instance, options.initialFilterText ?? '')
  const fakeGlobalThis = createGlobalThis(panel.view)
  const script = buildInternalLogHideScript(options.hiddenPrefix)
  run(script, fakeGlobalThis)
  return {
    ...filterClass,
    ...panel,
    instance,
    /** Re-run the very same script against the very same realm. */
    rerun: () => run(script, fakeGlobalThis),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  recordWarnings()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('INTERNAL_LOG_HIDDEN_PREFIX', () => {
  it('is the prefix the service layer actually stamps on its internal log lines', () => {
    expect(INTERNAL_LOG_HIDDEN_PREFIX).toBe('[service]')
  })

  it('is the prefix a no-argument buildInternalLogHideScript() hides', () => {
    const panel = installIntoReadyPanel()
    const hook = Object.getPrototypeOf(panel.instance).shouldBeVisible as ShouldBeVisible

    expect(hook.call(panel.instance, createViewMessage(`${INTERNAL_LOG_HIDDEN_PREFIX} receive msg`))).toBe(false)
  })
})

/**
 * `filter.currentFilter` is not the only ConsoleFilter that judges messages —
 * `clone()` returns a new one, and the sidebar filters through those. Landing
 * the hook on the shared prototype covers every instance at once, including
 * ones that do not exist yet when the script runs; a hook on the single
 * instance the script happened to see would cover none of them.
 */
describe('hook placement', () => {
  it('replaces shouldBeVisible on the ConsoleFilter prototype', () => {
    const panel = installIntoReadyPanel()

    expect(Object.getPrototypeOf(panel.instance).shouldBeVisible).not.toBe(panel.original)
    expect(panel.prototype.shouldBeVisible).not.toBe(panel.original)
  })

  it('leaves the ConsoleFilter instance itself unshadowed', () => {
    const panel = installIntoReadyPanel()

    expect(Object.prototype.hasOwnProperty.call(panel.instance, 'shouldBeVisible')).toBe(false)
  })

  it('also hides internal logs for a ConsoleFilter constructed after installation', () => {
    const panel = installIntoReadyPanel()
    const laterFilter = panel.newInstance()

    expect(laterFilter.shouldBeVisible(createViewMessage('[service] receive msg'))).toBe(false)
    expect(laterFilter.shouldBeVisible(createViewMessage('业务日志'))).toBe(true)
  })

  it('also hides internal logs for a clone of the filter it installed against', () => {
    const panel = installIntoReadyPanel()
    // What ConsoleFilter.clone() does: build another instance off the same
    // prototype rather than copying the object it was called on.
    const clone = panel.newInstance()

    expect(clone.shouldBeVisible(createViewMessage('[service] receive msg'))).toBe(false)
  })

  it('keeps judging through the same instance after its filter fields are mutated in place', () => {
    // Editing the filter box does not replace `currentFilter`; it rewrites the
    // existing instance's own fields. The hook must survive that, which it does
    // precisely because it never lived on the instance.
    const panel = installIntoReadyPanel()
    const mutated = panel.instance as unknown as Record<string, unknown>
    mutated.parsedFilters = [{ key: 'url', text: 'whatever', negative: false }]
    mutated.levelsMask = { verbose: true, info: true, warning: true, error: true }

    expect(panel.instance.shouldBeVisible(createViewMessage('[service] receive msg'))).toBe(false)
  })
})

/**
 * The hook may only ever subtract messages: internal lines vanish, everything
 * else keeps whatever verdict the panel's own filtering produced.
 */
describe('visibility verdicts', () => {
  it('hides a message whose text starts with the internal prefix', () => {
    const panel = installIntoReadyPanel()

    expect(panel.instance.shouldBeVisible(createViewMessage('[service] receive msg: xxx'))).toBe(false)
  })

  it('shows an ordinary message the original filter accepts', () => {
    const panel = installIntoReadyPanel({ verdict: true })

    expect(panel.instance.shouldBeVisible(createViewMessage('用户普通业务日志'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })

  it('keeps hiding an ordinary message the original filter rejects, so the developer\'s own filter still applies', () => {
    const panel = installIntoReadyPanel({ verdict: false })

    expect(panel.instance.shouldBeVisible(createViewMessage('被用户过滤规则排除的日志'))).toBe(false)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })

  it('treats the prefix as a prefix only — a mid-text occurrence is an ordinary message', () => {
    const panel = installIntoReadyPanel({ verdict: true })

    expect(panel.instance.shouldBeVisible(createViewMessage('用户日志里提到了 [service] 三个字'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })

  it('hides a message that is exactly the tag, with the rest of the line in later arguments', () => {
    const panel = installIntoReadyPanel()

    expect(panel.instance.shouldBeVisible(createViewMessage(INTERNAL_LOG_HIDDEN_PREFIX))).toBe(false)
  })

  it('shows a business log whose own tag merely begins with the internal one', () => {
    const panel = installIntoReadyPanel({ verdict: true })

    expect(panel.instance.shouldBeVisible(createViewMessage('[service-worker] started'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })

  it('shows a business log where the tag is not followed by a space', () => {
    const panel = installIntoReadyPanel({ verdict: true })

    expect(panel.instance.shouldBeVisible(createViewMessage('[service]业务状态'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })

  it('delegates with the calling ConsoleFilter as `this` and the untouched view message', () => {
    const calls: { thisArg: unknown, arg: unknown }[] = []
    const panel = installIntoReadyPanel({
      verdict(this: unknown, viewMessage: FakeViewMessage) {
        calls.push({ thisArg: this, arg: viewMessage })
        return true
      },
    })
    const viewMessage = createViewMessage('业务日志')

    panel.instance.shouldBeVisible(viewMessage)

    expect(calls).toHaveLength(1)
    expect(calls[0].thisArg).toBe(panel.instance)
    expect(calls[0].arg).toBe(viewMessage)
  })
})

/**
 * The visible text-filter input holds whatever the developer typed. Hiding
 * internal logs happens behind it and must not rewrite it.
 */
describe('visible text filter input', () => {
  it('never writes to filter.textFilterUI while installing', () => {
    const panel = installIntoReadyPanel({ initialFilterText: '我自己手打的过滤规则' })

    expect(panel.setValue).not.toHaveBeenCalled()
    expect(panel.filterText()).toBe('我自己手打的过滤规则')
  })

  it('leaves an empty filter box empty', () => {
    const panel = installIntoReadyPanel({ initialFilterText: '' })
    panel.instance.shouldBeVisible(createViewMessage('[service] receive msg'))

    expect(panel.setValue).not.toHaveBeenCalled()
    expect(panel.filterText()).toBe('')
  })
})

/**
 * Injection runs again on every panel attach, so a second execution must be a
 * no-op instead of stacking a second wrapper on top of the first.
 */
describe('repeated injection', () => {
  it('leaves the already installed hook in place when the script runs a second time', () => {
    const panel = installIntoReadyPanel()
    const installedHook = panel.prototype.shouldBeVisible

    panel.rerun()

    expect(panel.prototype.shouldBeVisible).toBe(installedHook)
  })

  it('routes an ordinary message through exactly one original call after two executions', () => {
    const panel = installIntoReadyPanel({ verdict: true })
    panel.rerun()

    expect(panel.instance.shouldBeVisible(createViewMessage('业务日志'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })
})

describe('refreshing already displayed messages', () => {
  it('asks the panel to re-run visibility over the messages it already rendered', () => {
    const panel = installIntoReadyPanel()

    expect(panel.onFilterChanged).toHaveBeenCalledTimes(1)
  })

  it('has the hook in place before asking, so the refresh judges against it and not the original', () => {
    const filterClass = createConsoleFilterClass()
    const hookSeenByRefresh: unknown[] = []
    const view = {
      filter: {
        currentFilter: filterClass.newInstance(),
        textFilterUI: { value: () => '', setValue: vi.fn() },
      },
      onFilterChanged: vi.fn(() => { hookSeenByRefresh.push(filterClass.prototype.shouldBeVisible) }),
    }

    run(buildInternalLogHideScript(), createGlobalThis(view))

    expect(hookSeenByRefresh).toHaveLength(1)
    expect(hookSeenByRefresh[0]).toBe(filterClass.prototype.shouldBeVisible)
    expect(hookSeenByRefresh[0]).not.toBe(filterClass.original)
  })
})

describe('a custom hidden prefix', () => {
  it('hides lines carrying the custom prefix', () => {
    const panel = installIntoReadyPanel({ hiddenPrefix: '[custom]' })

    expect(panel.instance.shouldBeVisible(createViewMessage('[custom] internal line'))).toBe(false)
  })

  it('stops hiding the default prefix once a custom one is given', () => {
    const panel = installIntoReadyPanel({ hiddenPrefix: '[custom]', verdict: true })

    expect(panel.instance.shouldBeVisible(createViewMessage('[service] receive msg'))).toBe(true)
    expect(panel.original).toHaveBeenCalledTimes(1)
  })
})
