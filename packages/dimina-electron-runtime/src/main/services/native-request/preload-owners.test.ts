import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createPreloadRequestOwners } from './preload-owners.js'
import type { NativeRequestService } from './types.js'

describe('native preload owner listeners', () => {
  it('returns a live caller to its listener baseline across router recreation', () => {
    const wc = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
    const disposeOwner = vi.fn()
    const service = { disposeOwner } as unknown as NativeRequestService
    for (let i = 0; i < 3; i++) {
      const owners = createPreloadRequestOwners(service)
      owners.ensure(wc); owners.ensure(wc)
      expect(wc.listenerCount('destroyed')).toBe(1)
      owners.dispose()
      expect(wc.listenerCount('destroyed')).toBe(0)
      owners.ensure(wc)
      expect(wc.listenerCount('destroyed')).toBe(0)
    }
    expect(disposeOwner.mock.calls).toEqual([['preload:7'], ['preload:7'], ['preload:7']])
  })

  it('releases only the destroyed caller and forgets its listener before teardown', () => {
    const wc = Object.assign(new EventEmitter(), { id: 9, isDestroyed: () => false })
    const disposeOwner = vi.fn()
    const owners = createPreloadRequestOwners({ disposeOwner } as unknown as NativeRequestService)
    owners.ensure(wc)
    wc.emit('destroyed')
    owners.dispose()
    expect(disposeOwner.mock.calls).toEqual([['preload:9']])
    expect(wc.listenerCount('destroyed')).toBe(0)
  })
})
