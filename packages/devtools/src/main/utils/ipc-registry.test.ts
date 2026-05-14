/**
 * Verifies that `IpcRegistry.on` swallows listener errors instead of letting
 * them escape into Electron's event loop:
 *
 *  1. A synchronous throw inside the listener does not propagate.
 *  2. An async-rejecting listener's rejection does not surface as an
 *     unhandled rejection.
 *  3. An `IpcValidationError` thrown by `validate()` (the schema reject path)
 *     is logged as a structured warning but does not propagate.
 *
 * Electron is mocked only enough to capture the `on/removeListener` calls —
 * mirroring the lightweight style used in `disposable.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub (minimal: only what IpcRegistry touches) ──────────────
const electronStubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  const handlers = new Map<string, AnyFn>()
  const listeners = new Map<string, Set<AnyFn>>()

  function reset() {
    handlers.clear()
    listeners.clear()
  }

  return { handlers, listeners, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown
  const ipcMain = {
    handle: vi.fn((channel: string, fn: AnyFn) => {
      electronStubs.handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      electronStubs.handlers.delete(channel)
    }),
    on: vi.fn((channel: string, fn: AnyFn) => {
      const set = electronStubs.listeners.get(channel) ?? new Set<AnyFn>()
      set.add(fn)
      electronStubs.listeners.set(channel, set)
    }),
    removeListener: vi.fn((channel: string, fn: AnyFn) => {
      electronStubs.listeners.get(channel)?.delete(fn)
    }),
  }
  return { ipcMain, default: { ipcMain } }
})

// Import after mocks are in place.
let IpcRegistry: typeof import('./ipc-registry.js').IpcRegistry
let validate: typeof import('./ipc-schema.js').validate

beforeEach(async () => {
  electronStubs.reset()
  vi.resetModules()
  ;({ IpcRegistry } = await import('./ipc-registry.js'))
  ;({ validate } = await import('./ipc-schema.js'))
})

/**
 * Invokes every registered ipcMain.on listener for `channel`, with a stubbed
 * event whose `sender` will be trusted by IpcRegistry's policy (when present).
 */
function emit(channel: string, ...args: unknown[]) {
  const fakeEvent = { sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }
  const set = electronStubs.listeners.get(channel)
  if (!set) throw new Error(`no listeners registered for '${channel}'`)
  for (const fn of set) fn(fakeEvent, ...args)
}

describe('IpcRegistry.on error handling', () => {
  it('does not propagate a synchronous throw from the listener', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reg = new IpcRegistry()
    reg.on('test:sync-throw', () => {
      throw new Error('boom-sync')
    })

    expect(() => emit('test:sync-throw')).not.toThrow()
    // logger.error routes through console.error; the channel + message must surface.
    const flat = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(flat).toContain('test:sync-throw')
    expect(flat).toContain('boom-sync')
    errSpy.mockRestore()
  })

  it('does not propagate an async listener rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reg = new IpcRegistry()
    reg.on('test:async-reject', async () => {
      throw new Error('boom-async')
    })

    expect(() => emit('test:async-reject')).not.toThrow()
    // Let the rejection settle through the .catch wired by IpcRegistry.on.
    await Promise.resolve()
    await Promise.resolve()

    const flat = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(flat).toContain('test:async-reject')
    expect(flat).toContain('boom-async')
    errSpy.mockRestore()
  })

  it('does not propagate when validate() rejects the payload (IpcValidationError)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The schema below requires args === [string]; we'll emit [123] to trip it.
    const { z } = await import('zod')
    const schema = z.tuple([z.string()])
    const reg = new IpcRegistry()
    reg.on('test:schema-fail', (_evt, ...args: unknown[]) => {
      validate('test:schema-fail', schema, args)
    })

    expect(() => emit('test:schema-fail', 123)).not.toThrow()

    const flat = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    // validate() warns once with the raw issues; the wrapper's reportListenerError
    // warns again with the compact "schema reject on 'channel' at [paths]" form.
    expect(flat).toContain('test:schema-fail')
    expect(flat).toMatch(/schema reject on 'test:schema-fail'/)
    warnSpy.mockRestore()
  })
})
