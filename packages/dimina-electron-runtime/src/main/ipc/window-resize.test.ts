import { describe, expect, it } from 'vitest'
import { createAppLifecycleController } from './app-lifecycle.js'
import { createWindowResizeController } from './window-resize.js'

describe('createWindowResizeController', () => {
  it('ignores a null/undefined callback id on register', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', undefined)
    controller.register('app-1', null)
    expect(controller.listeners('app-1')).toEqual([])
  })

  it('returns an empty snapshot for an unknown session', () => {
    const controller = createWindowResizeController()
    expect(controller.listeners('unknown')).toEqual([])
  })

  it('registers a callback id and lists it back', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    expect(controller.listeners('app-1')).toEqual(['cb-1'])
  })

  it('keeps a registered callback across multiple listener reads (keep semantics)', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    expect(controller.listeners('app-1')).toEqual(['cb-1'])
    expect(controller.listeners('app-1')).toEqual(['cb-1'])
  })

  it('dedupes the same callback id registered twice', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    controller.register('app-1', 'cb-1')
    expect(controller.listeners('app-1')).toEqual(['cb-1'])
  })

  it('isolates callback ids per session', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    controller.register('app-2', 'cb-2')
    expect(controller.listeners('app-1')).toEqual(['cb-1'])
    expect(controller.listeners('app-2')).toEqual(['cb-2'])
  })

  it('unregisters a single callback id, leaving the others in place', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    controller.register('app-1', 'cb-2')
    controller.unregister('app-1', 'cb-1')
    expect(controller.listeners('app-1')).toEqual(['cb-2'])
  })

  it('unregister with no callback id clears every listener of the session', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    controller.register('app-1', 'cb-2')
    controller.unregister('app-1')
    expect(controller.listeners('app-1')).toEqual([])
  })

  it('unregister on an unknown session is a no-op', () => {
    const controller = createWindowResizeController()
    expect(() => controller.unregister('unknown', 'cb-1')).not.toThrow()
    expect(() => controller.unregister('unknown')).not.toThrow()
  })

  it('dispose drops all listeners for a session without affecting others', () => {
    const controller = createWindowResizeController()
    controller.register('app-1', 'cb-1')
    controller.register('app-2', 'cb-2')
    controller.dispose('app-1')
    expect(controller.listeners('app-1')).toEqual([])
    expect(controller.listeners('app-2')).toEqual(['cb-2'])
  })

  // `count()` is the ledger's own report for leak assertions: a session that ended, or a listener that was removed, must leave nothing standing in for it — one retained entry per project open is how this grows unbounded.
  it('counts every listener across sessions and returns to zero as they go', () => {
    const controller = createWindowResizeController()
    expect(controller.count()).toBe(0)

    controller.register('app-1', 'cb-1')
    controller.register('app-1', 'cb-2')
    controller.register('app-2', 'cb-3')
    expect(controller.count()).toBe(3)

    controller.unregister('app-1', 'cb-1')
    expect(controller.count()).toBe(2)
    controller.unregister('app-1', 'cb-2')
    expect(controller.count()).toBe(1)
    controller.dispose('app-2')
    expect(controller.count()).toBe(0)
  })

  it('repeated register/dispose cycles leave the count exactly at baseline', () => {
    const controller = createWindowResizeController()
    for (let round = 0; round < 5; round++) {
      controller.register(`app-${round}`, 'cb-a')
      controller.register(`app-${round}`, 'cb-b')
      controller.dispose(`app-${round}`)
    }
    expect(controller.count()).toBe(0)
  })

  it('dispose on an unknown session is a no-op', () => {
    const controller = createWindowResizeController()
    expect(() => controller.dispose('unknown')).not.toThrow()
  })

  // The service dedups keep callbacks by function identity, so one listener reused across two subscription APIs reaches main under a single id.
  // Each registry owns its own entry for that id: removing the resize listener leaves the app-lifecycle listener registered.
  it('removing an id shared with an app-lifecycle listener leaves that listener registered', () => {
    const resize = createWindowResizeController()
    const lifecycle = createAppLifecycleController()
    resize.register('app-1', 'cb-shared')
    lifecycle.register('app-1', 'onAppShow', 'cb-shared')

    resize.unregister('app-1', 'cb-shared')

    expect(resize.listeners('app-1')).toEqual([])
    expect(lifecycle.listeners('app-1', 'onAppShow')).toEqual(['cb-shared'])
  })
})
