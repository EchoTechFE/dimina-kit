import { describe, expect, it, vi } from 'vitest'
import { createRuntimeEvents } from './runtime-events.js'

describe('createRuntimeEvents', () => {
  it('isolates listener failures so later runtime listeners still run', () => {
    const events = createRuntimeEvents()
    const error = new Error('host listener failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reached = vi.fn()
    events.on('session-status', () => {
      throw error
    })
    events.on('session-status', reached)

    expect(() => events.emit('session-status', {
      appId: 'app',
      phase: 'running',
    })).not.toThrow()
    expect(reached).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith(
      "[electron-runtime] 'session-status' listener failed",
      error,
    )
    consoleError.mockRestore()
  })
})
