/**
 * `createInternalDevtoolsWindow` must report host visibility transitions
 * ITSELF, at the moment it performs them — never by relying on the native
 * BrowserWindow 'show'/'hide' events. On real macOS those events were
 * observed (instrumented-bundle trace against the live app) to fire for
 * NEITHER `show()`/`showInactive()` NOR `hide()`, which left every
 * onHostChanged subscriber (console/diagnostics/network global mirrors)
 * permanently believing the window never opened — the standalone debug
 * window's panels stayed empty on every platform path that skips those
 * events. The mock here is faithful to that reality: `show`/`showInactive`/
 * `hide` do NOT emit any event; only real destruction emits 'closed'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { createInternalDevtoolsWindow } from './index.js'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  const browserWindows: unknown[] = []
  function makeEmitter() {
    const listeners: Record<string, Set<AnyFn>> = {}
    return {
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return this },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return this
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
  }
  return { browserWindows, makeEmitter, reset: () => { browserWindows.length = 0 } }
})

vi.mock('electron', () => {
  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    isDestroyed = () => this.destroyed
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    setDevToolsWebContents = vi.fn()
    isDevToolsOpened = vi.fn(() => false)
  }
  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }
  class View {
    children: unknown[] = []
    addChildView(c: unknown) { this.children.push(c) }
    removeChildView(c: unknown) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1) }
  }
  class BrowserWindowStub {
    private em = stubs.makeEmitter()
    destroyed = false
    webContents = new WebContents()
    contentView = new View()
    constructor() { stubs.browserWindows.push(this) }
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    isDestroyed = () => this.destroyed
    // Faithful to the observed real-macOS behavior: NO 'show'/'hide' events.
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    hide = vi.fn()
    close = vi.fn(() => {
      let prevented = false
      this.em.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) {
        this.destroyed = true
        this.em.emit('closed')
      }
    })
    destroy = vi.fn(() => { this.destroyed = true; this.em.emit('closed') })
  }
  return { BrowserWindow: BrowserWindowStub, WebContentsView, View, default: {} }
})

let target: BrowserWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  stubs.reset()
  target = new BrowserWindow()
  process.env.NODE_ENV = 'production'
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

interface StubWin {
  contentView: { children: Array<{ webContents: unknown }> }
  close: () => void
}
function lastWindow(): StubWin {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubWin
}

describe('onHostChanged transitions are pushed by the controller itself, independent of native show/hide events', () => {
  it('open() reports the host wc even when show() emits no event', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)

    ctrl.open()

    const hostWc = lastWindow().contentView.children[0]!.webContents
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(hostWc)
  })

  it('the intercepted native close reports null even when hide() emits no event, and reopen reports the host again — strictly alternating, no duplicates', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const calls: Array<unknown> = []
    ctrl.onHostChanged((hostWc) => { calls.push(hostWc) })

    ctrl.open()
    lastWindow().close()
    ctrl.open()
    lastWindow().close()
    ctrl.open()

    const hostWc = lastWindow().contentView.children[0]!.webContents
    expect(calls).toEqual([hostWc, null, hostWc, null, hostWc])
  })

  it('a second open() while already visible does not re-notify (transition dedup, not event-count dedup)', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)

    ctrl.open()
    ctrl.open()

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
