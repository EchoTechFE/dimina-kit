/**
 * Fakes shaped like the Chrome DevTools front-end objects
 * `buildInternalLogHideScript()`'s generated source talks to, shared by
 * console-filter.test.ts (what the hook does) and
 * console-filter-degradation.test.ts (what happens when the panel is not there
 * or the front-end API has moved).
 *
 * These are STUBS OF A FOREIGN API, not a second implementation: every test
 * runs the real generated script string through `new Function`, so the fakes
 * only have to expose the handful of members the script reaches for. What they
 * cannot prove is that the real front-end still has those members — that is
 * e2e/console-filter-live.spec.ts's job.
 */
import { vi, type Mock } from 'vitest'

export interface FakeViewMessage {
  consoleMessage: () => { messageText: string }
}

export type ShouldBeVisible = (this: unknown, viewMessage: FakeViewMessage) => boolean

export interface FakeConsoleFilterClass {
  original: Mock<ShouldBeVisible>
  prototype: { shouldBeVisible?: ShouldBeVisible }
  newInstance: () => { shouldBeVisible: ShouldBeVisible }
}

export interface FakeConsoleView {
  view: {
    filter: {
      currentFilter: object
      textFilterUI: { value: () => string, setValue: Mock<(next: string) => void> }
    }
    onFilterChanged: Mock<() => void>
  }
  setValue: Mock<(next: string) => void>
  onFilterChanged: Mock<() => void>
  filterText: () => string
}

/** A ConsoleViewMessage stub exposing the single field the hook inspects. */
export function createViewMessage(messageText: string): FakeViewMessage {
  return { consoleMessage: () => ({ messageText }) }
}

/**
 * A ConsoleFilter "class": one shared prototype carrying `shouldBeVisible`,
 * plus a factory for further instances off that same prototype — what
 * `ConsoleFilter.clone()` produces. `original` is the pre-existing
 * implementation the hook must delegate to.
 */
export function createConsoleFilterClass(verdict: boolean | ShouldBeVisible = true): FakeConsoleFilterClass {
  const impl: ShouldBeVisible = typeof verdict === 'function' ? verdict : () => verdict
  const original = vi.fn(impl)
  const prototype: { shouldBeVisible?: ShouldBeVisible } = { shouldBeVisible: original as ShouldBeVisible }
  return {
    original,
    prototype,
    newInstance: () => Object.create(prototype) as { shouldBeVisible: ShouldBeVisible },
  }
}

/** A ConsoleFilter whose prototype chain carries no `shouldBeVisible` at all. */
export function createConsoleFilterClassWithoutHook() {
  const prototype: Record<string, unknown> = Object.create(null)
  return { prototype, newInstance: () => Object.create(prototype) as object }
}

/** The ConsoleView surface the script reaches through: filter + refresh entry point. */
export function createConsoleView(currentFilter: object, initialFilterText = ''): FakeConsoleView {
  let filterText = initialFilterText
  const setValue = vi.fn((next: string) => { filterText = next })
  const onFilterChanged = vi.fn()
  return {
    view: {
      filter: {
        currentFilter,
        textFilterUI: { value: () => filterText, setValue },
      },
      onFilterChanged,
    },
    setValue,
    onFilterChanged,
    filterText: () => filterText,
  }
}

/** A front end whose bootstrap has finished: the probe returns instead of throwing. */
export function createReadyEui() {
  return { ShortcutRegistry: { ShortcutRegistry: { instance: () => ({}) } } }
}

export function createGlobalThis(view: unknown) {
  return { EUI: createReadyEui(), Console: { ConsoleView: { instance: () => view } } }
}

export function run(script: string, fakeGlobalThis: object): void {
  new Function('globalThis', script)(fakeGlobalThis)
}

/**
 * Collect `console.warn` output as plain strings for the whole test file.
 *
 * Reading `warnSpy.mock.calls` instead would hand every assertion an untyped
 * `any[]`; the degradation tests care about WHICH warning was emitted, so the
 * text has to survive into the assertion with its type intact.
 */
export function recordWarnings(): { messages: string[] } {
  const record = { messages: [] as string[] }
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    record.messages.push(args.map((arg) => String(arg)).join(' '))
  })
  return record
}
