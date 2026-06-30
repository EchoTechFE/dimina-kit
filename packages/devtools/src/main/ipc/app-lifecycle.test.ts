import { describe, it, expect, beforeEach } from 'vitest'
import { createAppLifecycleController } from './app-lifecycle'
import type { AppLifecycleController, AppLifecycleEvent } from './app-lifecycle'

const ALL_EVENTS: AppLifecycleEvent[] = ['onAppShow', 'onAppHide', 'onError']

describe('createAppLifecycleController', () => {
  let ctrl: AppLifecycleController

  beforeEach(() => {
    ctrl = createAppLifecycleController()
  })

  it('returns empty array for unknown session without throwing', () => {
    expect(ctrl.listeners('s1', 'onAppShow')).toEqual([])
  })

  it('register then listeners contains the callbackId', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    const result = ctrl.listeners('s1', 'onAppShow')
    expect(result).toHaveLength(1)
    expect(result).toContain('cb1')
  })

  it('ignores null callbackId (no-op)', () => {
    ctrl.register('s1', 'onAppShow', null)
    expect(ctrl.listeners('s1', 'onAppShow')).toEqual([])
  })

  it('ignores undefined callbackId (no-op)', () => {
    ctrl.register('s1', 'onAppShow', undefined)
    expect(ctrl.listeners('s1', 'onAppShow')).toEqual([])
  })

  it('deduplicates the same callbackId (Set semantics)', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb1')
    expect(ctrl.listeners('s1', 'onAppShow')).toHaveLength(1)
  })

  it('accumulates different callbackIds', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb2')
    const result = ctrl.listeners('s1', 'onAppShow')
    expect(result).toHaveLength(2)
    expect(result).toEqual(expect.arrayContaining(['cb1', 'cb2']))
  })

  it('events are isolated from each other', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    expect(ctrl.listeners('s1', 'onAppHide')).toEqual([])
    expect(ctrl.listeners('s1', 'onError')).toEqual([])
  })

  it('all three event keys are independently tracked', () => {
    ctrl.register('s1', 'onAppShow', 'cbShow')
    ctrl.register('s1', 'onAppHide', 'cbHide')
    ctrl.register('s1', 'onError', 'cbErr')
    expect(ctrl.listeners('s1', 'onAppShow')).toContain('cbShow')
    expect(ctrl.listeners('s1', 'onAppHide')).toContain('cbHide')
    expect(ctrl.listeners('s1', 'onError')).toContain('cbErr')
  })

  it('sessions are isolated from each other', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    expect(ctrl.listeners('s2', 'onAppShow')).toEqual([])
  })

  it('unregister removes all ids for that (session, event)', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb2')
    ctrl.unregister('s1', 'onAppShow')
    expect(ctrl.listeners('s1', 'onAppShow')).toEqual([])
  })

  it('unregister does not affect other events of the same session', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppHide', 'cb2')
    ctrl.unregister('s1', 'onAppShow')
    expect(ctrl.listeners('s1', 'onAppHide')).toContain('cb2')
  })

  it('unregister does not affect the same event on other sessions', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s2', 'onAppShow', 'cb2')
    ctrl.unregister('s1', 'onAppShow')
    expect(ctrl.listeners('s2', 'onAppShow')).toContain('cb2')
  })

  it('unregister on unknown session/event is a no-op', () => {
    expect(() => ctrl.unregister('nonexistent', 'onAppShow')).not.toThrow()
  })

  it('dispose clears all three events for that session', () => {
    for (const event of ALL_EVENTS) {
      ctrl.register('s1', event, `cb-${event}`)
    }
    ctrl.dispose('s1')
    for (const event of ALL_EVENTS) {
      expect(ctrl.listeners('s1', event)).toEqual([])
    }
  })

  it('dispose does not affect other sessions', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s2', 'onAppShow', 'cb2')
    ctrl.dispose('s1')
    expect(ctrl.listeners('s2', 'onAppShow')).toContain('cb2')
  })

  it('dispose on unknown session is a no-op', () => {
    expect(() => ctrl.dispose('nonexistent')).not.toThrow()
  })

  it('listeners returns a snapshot — mutating it does not corrupt internal state', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    const snapshot = ctrl.listeners('s1', 'onAppShow')
    snapshot.push('injected')
    expect(ctrl.listeners('s1', 'onAppShow')).toHaveLength(1)
  })

  // ── Selective unregister (callbackId overload) ────────────────────────────
  // Guards the bug where unregister(session, event, id) removed ALL listeners
  // for the event instead of only the one matching `id`.

  it('unregister(session, event, id) removes only that id, leaving others intact', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb2')
    ctrl.unregister('s1', 'onAppShow', 'cb1')
    const remaining = ctrl.listeners('s1', 'onAppShow')
    expect(remaining).toHaveLength(1)
    expect(remaining).toContain('cb2')
    expect(remaining).not.toContain('cb1')
  })

  it('unregister(session, event) with no id clears all listeners for that event', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb2')
    ctrl.unregister('s1', 'onAppShow')
    expect(ctrl.listeners('s1', 'onAppShow')).toHaveLength(0)
  })

  it('unregister(session, event, missing-id) is a no-op — both original listeners remain', () => {
    ctrl.register('s1', 'onAppShow', 'cb1')
    ctrl.register('s1', 'onAppShow', 'cb2')
    ctrl.unregister('s1', 'onAppShow', 'not-registered')
    const remaining = ctrl.listeners('s1', 'onAppShow')
    expect(remaining).toHaveLength(2)
    expect(remaining).toContain('cb1')
    expect(remaining).toContain('cb2')
  })
})
