/**
 * Guards the load-deferred injector's core contract: however many times a
 * (wc, kind) is scheduled during ONE load window, exactly one
 * `did-stop-loading` hook exists and the LATEST runner wins — repeated
 * re-points must not pile one waiter per call on the host wc.
 */
import { describe, expect, it, vi } from 'vitest'

import { createLoadDeferredInjector } from './inject-when-ready.js'
import type { WebContents } from 'electron'

function fakeWc(loading: boolean, url = 'devtools://devtools/bundled/devtools_app.html') {
  const onceListeners = new Map<string, Array<() => void>>()
  let destroyed = false
  const wc = {
    isDestroyed: () => destroyed,
    isLoading: () => loading,
    getURL: () => url,
    setLoading(v: boolean) { loading = v },
    setUrl(v: string) { url = v },
    destroy() { destroyed = true },
    once: vi.fn((event: string, fn: () => void) => {
      const arr = onceListeners.get(event) ?? []
      arr.push(fn)
      onceListeners.set(event, arr)
    }),
    fire(event: string) {
      const arr = onceListeners.get(event) ?? []
      onceListeners.set(event, [])
      for (const fn of arr) fn()
    },
    hookCount(event: string) { return (onceListeners.get(event) ?? []).length },
  }
  return wc
}

const asWc = (wc: unknown): WebContents => wc as WebContents

describe('createLoadDeferredInjector', () => {
  it('runs immediately when the wc is idle on a real document', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(false)
    const run = vi.fn()
    inject(asWc(wc), 'tabs', run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(wc.hookCount('did-stop-loading')).toBe(0)
  })

  it('a never-navigated wc defers to the UPCOMING load instead of running against about:blank', () => {
    const inject = createLoadDeferredInjector()
    // Rebuild-time reality: injects are scheduled BEFORE openDevTools starts
    // the devtools:// navigation — the wc is idle but has no document yet.
    const wc = fakeWc(false, '')
    const run = vi.fn()
    inject(asWc(wc), 'console-default', run)
    expect(run).not.toHaveBeenCalled()
    expect(wc.hookCount('did-stop-loading')).toBe(1)
    wc.setUrl('devtools://devtools/bundled/devtools_app.html')
    wc.fire('did-stop-loading')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps ONE did-stop-loading hook per kind however many times it is scheduled mid-load', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(true)
    for (let i = 0; i < 50; i++) inject(asWc(wc), 'open-in-editor', vi.fn())
    expect(wc.hookCount('did-stop-loading')).toBe(1)
  })

  it('the LATEST runner wins when the load ends (a re-point swapping the service wc supersedes the stale closure)', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(true)
    const stale = vi.fn()
    const latest = vi.fn()
    inject(asWc(wc), 'open-in-editor', stale)
    inject(asWc(wc), 'open-in-editor', latest)
    wc.fire('did-stop-loading')
    expect(stale).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('distinct kinds get their own hook and both run post-load', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(true)
    const tabs = vi.fn()
    const editor = vi.fn()
    inject(asWc(wc), 'tabs', tabs)
    inject(asWc(wc), 'open-in-editor', editor)
    expect(wc.hookCount('did-stop-loading')).toBe(2)
    wc.fire('did-stop-loading')
    expect(tabs).toHaveBeenCalledTimes(1)
    expect(editor).toHaveBeenCalledTimes(1)
  })

  it('defers when the MAIN frame is loading even if the coarse isLoading already reads false', () => {
    const inject = createLoadDeferredInjector()
    const wc = Object.assign(fakeWc(false), { isLoadingMainFrame: () => true })
    const run = vi.fn()
    inject(asWc(wc), 'tabs', run)
    expect(run).not.toHaveBeenCalled()
    expect(wc.hookCount('did-stop-loading')).toBe(1)
  })

  it('a wc destroyed before the load ends never runs the pending runner', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(true)
    const run = vi.fn()
    inject(asWc(wc), 'tabs', run)
    wc.destroy()
    wc.fire('did-stop-loading')
    expect(run).not.toHaveBeenCalled()
  })

  it('after a load window drains, the next schedule on the (now idle) wc runs immediately again', () => {
    const inject = createLoadDeferredInjector()
    const wc = fakeWc(true)
    inject(asWc(wc), 'tabs', vi.fn())
    wc.fire('did-stop-loading')
    wc.setLoading(false)
    const run = vi.fn()
    inject(asWc(wc), 'tabs', run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(wc.hookCount('did-stop-loading')).toBe(0)
  })
})
