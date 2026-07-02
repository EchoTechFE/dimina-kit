/**
 * Guards `describeMaxListenersWarning` / `installMaxListenersWarningDiagnostic`
 * against silently losing the ability to pin a `MaxListenersExceededWarning` to
 * a concrete WebContents. Node's default warning message names the event and
 * count but not which Electron surface (DevTools host, service host, main
 * window, …) tripped it — the decoder reflectively reads `emitter.id` /
 * `getType()` / `getURL()` / `isDestroyed()` off the warning object so that
 * information isn't lost. It must return `null` for anything that isn't a
 * `MaxListenersExceededWarning`, and it must not throw when the emitter is
 * missing or one of its probe methods throws — a defensive decoder that itself
 * crashes on a malformed warning would replace one diagnostic gap with another.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  describeMaxListenersWarning,
  installMaxListenersWarningDiagnostic,
  type MaxListenersWarningReport,
} from './max-listeners-diagnostic.js'

function makeWarning(overrides: Partial<{
  name: string
  type: string
  count: number
  emitter: unknown
}> = {}): Error {
  const warning = new Error('10 foo listeners added to [EventEmitter]') as Error & {
    emitter?: unknown
    type?: string
    count?: number
  }
  warning.name = overrides.name ?? 'MaxListenersExceededWarning'
  if ('type' in overrides) warning.type = overrides.type
  if ('count' in overrides) warning.count = overrides.count
  if ('emitter' in overrides) warning.emitter = overrides.emitter
  return warning
}

function makeEmitter(overrides: Partial<{
  id: unknown
  getType: () => string
  getURL: () => string
  isDestroyed: () => boolean
}> = {}) {
  return {
    id: 42,
    getType: () => 'window',
    getURL: () => 'file:///service.html',
    isDestroyed: () => false,
    ...overrides,
  }
}

describe('describeMaxListenersWarning', () => {
  it('returns null for a plain Error that is not a MaxListenersExceededWarning', () => {
    expect(describeMaxListenersWarning(new Error('unrelated'))).toBeNull()
  })

  it('returns null for a differently-named warning (e.g. DeprecationWarning)', () => {
    const warning = makeWarning({ name: 'DeprecationWarning', type: 'foo', count: 11, emitter: makeEmitter() })
    expect(describeMaxListenersWarning(warning)).toBeNull()
  })

  it('decodes event/count/wcId/wcType/url/destroyed/stack off a matching warning', () => {
    const emitter = makeEmitter({ id: 7, getType: () => 'webview', getURL: () => 'file:///render.html', isDestroyed: () => false })
    const warning = makeWarning({ type: 'close', count: 11, emitter })

    const report = describeMaxListenersWarning(warning)

    expect(report).not.toBeNull()
    expect(report).toMatchObject({
      event: 'close',
      count: 11,
      wcId: 7,
      wcType: 'webview',
      url: 'file:///render.html',
      destroyed: false,
    })
    expect(report?.stack).toBe(warning.stack)
  })

  it('omits wcId when emitter.id is not a number', () => {
    const emitter = makeEmitter({ id: 'not-a-number' })
    const warning = makeWarning({ type: 'close', count: 11, emitter })

    const report = describeMaxListenersWarning(warning)

    expect(report?.wcId).toBeUndefined()
  })

  it('does not throw and reports undefined fields when emitter is missing', () => {
    const warning = makeWarning({ type: 'close', count: 11 })

    let report: MaxListenersWarningReport | null | undefined
    expect(() => { report = describeMaxListenersWarning(warning) }).not.toThrow()

    const decoded = report as MaxListenersWarningReport | null
    expect(decoded).not.toBeNull()
    expect(decoded).toMatchObject({
      event: 'close',
      count: 11,
      wcId: undefined,
      wcType: undefined,
      url: undefined,
      destroyed: undefined,
    })
  })

  it('does not throw and reports undefined when a probe method is a non-function value', () => {
    // A malformed emitter whose getType/getURL is a non-function (not just a
    // throwing function): a decoder that eagerly evaluates `emitter.getType.bind`
    // before guarding would throw here while building the argument.
    const warning = makeWarning({
      type: 'close',
      count: 11,
      emitter: { id: 5, getType: 'nope', getURL: 123, isDestroyed: false },
    })

    let report: MaxListenersWarningReport | null | undefined
    expect(() => { report = describeMaxListenersWarning(warning) }).not.toThrow()

    const decoded = report as MaxListenersWarningReport | null
    expect(decoded?.wcId).toBe(5)
    expect(decoded?.wcType).toBeUndefined()
    expect(decoded?.url).toBeUndefined()
    expect(decoded?.destroyed).toBeUndefined()
  })

  it('does not throw and reports url: undefined when emitter.getURL() throws', () => {
    const emitter = makeEmitter({
      getURL: () => { throw new Error('destroyed webContents') },
    })
    const warning = makeWarning({ type: 'close', count: 11, emitter })

    let report: MaxListenersWarningReport | null | undefined
    expect(() => { report = describeMaxListenersWarning(warning) }).not.toThrow()

    const decoded = report as MaxListenersWarningReport | null
    expect(decoded).not.toBeNull()
    expect(decoded?.url).toBeUndefined()
    // Sibling fields still resolve normally — one throwing probe doesn't poison the rest.
    expect(decoded?.wcId).toBe(42)
    expect(decoded?.wcType).toBe('window')
  })
})

describe('installMaxListenersWarningDiagnostic', () => {
  it('registers a process "warning" listener and the disposer removes it', () => {
    const before = process.listenerCount('warning')
    const dispose = installMaxListenersWarningDiagnostic(vi.fn())
    try {
      expect(process.listenerCount('warning')).toBe(before + 1)
    } finally {
      dispose()
    }
    expect(process.listenerCount('warning')).toBe(before)
  })

  it('calls log once with the decoded report when a MaxListenersExceededWarning is emitted', () => {
    const log = vi.fn()
    const dispose = installMaxListenersWarningDiagnostic(log)
    try {
      const emitter = makeEmitter({ id: 99, getType: () => 'window', getURL: () => 'file:///service.html' })
      const warning = makeWarning({ type: 'close', count: 12, emitter })

      process.emit('warning', warning)

      expect(log).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        event: 'close',
        count: 12,
        wcId: 99,
      }))
    } finally {
      dispose()
    }
  })

  it('does not call log for a non-matching warning', () => {
    const log = vi.fn()
    const dispose = installMaxListenersWarningDiagnostic(log)
    try {
      process.emit('warning', makeWarning({ name: 'DeprecationWarning' }))
      expect(log).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
