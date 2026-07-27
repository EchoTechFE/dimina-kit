/**
 * `createInternalDevtoolsWindow(target).open()` must never steal OS-level
 * focus during an e2e run — mirrors main-window/create.ts's exact
 * `NODE_ENV === 'test'` → `showInactive()` rule (see that file's
 * `auto-show.test.ts` for the sibling coverage). `showInactive()` makes the
 * window visible without activating it, so a real e2e run opening this
 * window never pulls foreground focus away from whatever the developer
 * running the suite has open; production always wants a real
 * `show()`+`focus()` — this IS the button click meant to bring the debug
 * window forward.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { createInternalDevtoolsWindow } from './index.js'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>
  const browserWindows: unknown[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
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
    emit = this.em.emit.bind(this.em)
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
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => { this.em.emit('close') })
    finishClose = () => { this.destroyed = true; this.em.emit('closed') }
    destroy = vi.fn()
  }

  return { BrowserWindow: BrowserWindowStub, WebContentsView, View, default: {} }
})

interface StubBrowserWindow {
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

let target: BrowserWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  stubs.reset()
  target = new BrowserWindow()
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function lastWindow(): StubBrowserWindow {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindow
}

describe('createInternalDevtoolsWindow.open(): test-mode focus suppression', () => {
  it('calls showInactive() and never show()/focus() when NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test'
    const ctrl = createInternalDevtoolsWindow(target)

    ctrl.open()

    const win = lastWindow()
    expect(win.showInactive).toHaveBeenCalledTimes(1)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('calls show()+focus() and never showInactive() outside test mode', () => {
    process.env.NODE_ENV = 'production'
    const ctrl = createInternalDevtoolsWindow(target)

    ctrl.open()

    const win = lastWindow()
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.showInactive).not.toHaveBeenCalled()
  })
})
