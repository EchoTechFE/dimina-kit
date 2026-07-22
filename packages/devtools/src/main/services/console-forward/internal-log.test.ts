/**
 * Behavior tests for `isInternalLogMessage`.
 *
 * Distinguishes dimina framework-internal console output (service layer logs
 * whose first arg is the literal `'[service]'` prefix; render layer logs whose
 * first arg is the literal `'[system]'` string) from the guest mini-program's
 * own business `console.*` calls. Used to gate what Phase 3's per-app Console
 * panel shows (business only) vs. what the global console mirror shows (all,
 * unfiltered).
 */
import { describe, expect, it } from 'vitest'
import { isInternalLogMessage } from './internal-log.js'
import type { GuestConsoleEntry } from './index.js'

describe('isInternalLogMessage', () => {
  it('recognizes a service-layer framework log with a trailing message', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: ['[service] receive msg: ', '{}'] }
    expect(isInternalLogMessage(entry)).toBe(true)
  })

  it('recognizes a service-layer framework log that is exactly the prefix', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: ['[service] init'] }
    expect(isInternalLogMessage(entry)).toBe(true)
  })

  it('recognizes another service-layer framework log', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: ['[service] app instance already existed'] }
    expect(isInternalLogMessage(entry)).toBe(true)
  })

  it('recognizes a render-layer framework log with trailing args', () => {
    const entry: GuestConsoleEntry = { source: 'render', args: ['[system]', '[render]', 'receive msg: ', '{}'] }
    expect(isInternalLogMessage(entry)).toBe(true)
  })

  it('recognizes a render-layer framework log that is just the system tag plus more', () => {
    const entry: GuestConsoleEntry = { source: 'render', args: ['[system]', '[render]', 'init'] }
    expect(isInternalLogMessage(entry)).toBe(true)
  })

  it('does not flag a service-layer business log', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: ['用户自己的业务日志', 123] }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('does not flag a render-layer business log', () => {
    const entry: GuestConsoleEntry = { source: 'render', args: ['用户在小程序里 console.log 的内容'] }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('does not flag an entry with an empty args array', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: [] }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('does not flag an entry whose args field is explicitly undefined', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: undefined }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('does not flag an entry with no args field at all', () => {
    const entry: GuestConsoleEntry = { source: 'service' }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('only inspects the first arg, ignoring a framework-looking prefix later in the array', () => {
    const entry: GuestConsoleEntry = { source: 'service', args: [123, '[service] xxx'] }
    expect(isInternalLogMessage(entry)).toBe(false)
  })

  it('does not match a merely similar-looking bracketed tag that is not the exact framework prefix', () => {
    const entry: GuestConsoleEntry = {
      source: 'service',
      args: ['[servicexyz] 不是真正的框架前缀，只是碰巧同样字符开头'],
    }
    expect(isInternalLogMessage(entry)).toBe(false)
  })
})
