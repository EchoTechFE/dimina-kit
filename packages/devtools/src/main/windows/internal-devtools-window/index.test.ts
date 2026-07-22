/**
 * `createInternalDevtoolsWindow(target)` owns a standalone (non-dock)
 * BrowserWindow that hosts the Chrome DevTools front-end for `target` via a
 * WebContentsView mounted into its own `contentView`, attached through
 * `target.webContents.setDevToolsWebContents(hostView.webContents)` +
 * `target.webContents.openDevTools({ mode: 'detach', activate: false })`.
 *
 * Invariants under test:
 *  - first `.open()` builds exactly one window + host view and attaches it
 *    to target DevTools ONCE;
 *  - every later `.open()` — whether the window is currently visible or
 *    hidden — just re-shows/focuses the SAME window and NEVER builds a
 *    second window or re-navigates the host (Electron only allows
 *    `setDevToolsWebContents`'s host argument to be set once, and — per this
 *    session's real-repro + source-level investigation — rebuilding the
 *    attachment on every close/reopen cannot be made reliable: see index.ts's
 *    module doc comment);
 *  - the window's native 'close' (title-bar button / Cmd+W) is intercepted
 *    and hides instead of destroying — the DevTools attachment survives;
 *  - `.dispose()` is the one path that actually destroys the window and
 *    attachment, and is a no-op otherwise;
 *  - a destroyed target does not make `.open()` throw.
 *
 * Electron mock: trimmed to BrowserWindow / WebContentsView / View — this is
 * a focused unit test of the window controller alone, no full
 * `createDevtoolsRuntime` assembly (that lives in
 * internal-devtools-window-wiring.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { createInternalDevtoolsWindow } from './index.js'
import type { InternalDevtoolsWindow } from './index.js'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  /** Every BrowserWindow constructed by the code under test, in order. */
  const browserWindows: unknown[] = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
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

  function reset() {
    browserWindows.length = 0
  }

  return { browserWindows, makeEmitter, reset }
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
    show = vi.fn(() => { this.em.emit('show') })
    showInactive = vi.fn(() => { this.em.emit('show') })
    focus = vi.fn()
    hide = vi.fn(() => { this.em.emit('hide') })
    // Real BrowserWindow.close(): fires 'close' with a preventDefault-able
    // event; if not prevented, proceeds to destroy + 'closed'. Production
    // code always prevents this (see index.ts) — the non-prevented branch
    // here exists only to make the mock behave like real Electron, not
    // because production code is expected to hit it.
    close = vi.fn(() => {
      let prevented = false
      this.em.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) {
        this.destroyed = true
        this.em.emit('closed')
      }
    })
    // Real BrowserWindow.destroy(): force-closes WITHOUT emitting 'close',
    // but guarantees 'closed'.
    destroy = vi.fn(() => { this.destroyed = true; this.em.emit('closed') })
  }

  return { BrowserWindow: BrowserWindowStub, WebContentsView, View, default: {} }
})

/** Narrow stub shapes used for assertions — mirrors the pattern in
 * open-settings-wiring.test.ts (the real Electron types don't expose the
 * mock's vi.fn() spies, so assertions go through a local structural type). */
interface StubWebContents {
  isDestroyed: () => boolean
  openDevTools: ReturnType<typeof vi.fn>
  setDevToolsWebContents: ReturnType<typeof vi.fn>
}
interface StubView {
  children: unknown[]
}
interface StubBrowserWindow {
  webContents: StubWebContents
  contentView: StubView
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

let target: BrowserWindow
let targetStub: StubBrowserWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  stubs.reset()
  target = new BrowserWindow()
  targetStub = target as unknown as StubBrowserWindow
  // These tests assert the PRODUCTION show()+focus() path — vitest's own
  // ambient NODE_ENV=test would otherwise divert open() into showInactive()
  // (see test-mode-show-inactive.test.ts for coverage of THAT branch).
  // Mirrors main-window/auto-show.test.ts's established save/restore pattern.
  process.env.NODE_ENV = 'production'
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function lastWindow(): StubBrowserWindow {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindow
}

describe('createInternalDevtoolsWindow: first open() builds and attaches the host window', () => {
  it('constructs one new BrowserWindow, mounts a WebContentsView host, and attaches it to target DevTools', () => {
    const ctrl: InternalDevtoolsWindow = createInternalDevtoolsWindow(target)
    const before = stubs.browserWindows.length

    ctrl.open()

    expect(stubs.browserWindows.length).toBe(before + 1)
    const hostWindow = lastWindow()
    expect(hostWindow).not.toBe(targetStub)

    // A WebContentsView host was mounted into the new window's contentView.
    expect(hostWindow.contentView.children.length).toBe(1)
    const hostView = hostWindow.contentView.children[0] as { webContents: unknown }

    expect(targetStub.webContents.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(targetStub.webContents.setDevToolsWebContents).toHaveBeenCalledWith(hostView.webContents)
    expect(targetStub.webContents.openDevTools).toHaveBeenCalledTimes(1)
    expect(targetStub.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: false })

    // setDevToolsWebContents must land before openDevTools — the reverse
    // order would open DevTools before the front-end host exists.
    const setOrder = targetStub.webContents.setDevToolsWebContents.mock.invocationCallOrder[0]
    const openOrder = targetStub.webContents.openDevTools.mock.invocationCallOrder[0]
    expect(setOrder).toBeLessThan(openOrder as number)

    expect(hostWindow.show).toHaveBeenCalled()
    expect(hostWindow.focus).toHaveBeenCalled()
  })
})

describe('createInternalDevtoolsWindow: open() while the window is alive reuses it', () => {
  it('does not construct a second window and does not re-navigate the DevTools host', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()
    const countAfterFirst = stubs.browserWindows.length
    const hostWindow = lastWindow()

    ctrl.open()

    // Electron only allows the host argument of setDevToolsWebContents to be
    // navigated once; a second call on the same host is a real bug class.
    expect(stubs.browserWindows.length).toBe(countAfterFirst)
    expect(targetStub.webContents.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(targetStub.webContents.openDevTools).toHaveBeenCalledTimes(1)

    // Re-showing an existing window for a repeat button click is still expected.
    expect(hostWindow.show).toHaveBeenCalledTimes(2)
    expect(hostWindow.focus).toHaveBeenCalledTimes(2)
  })
})

describe('createInternalDevtoolsWindow: close hides instead of destroying', () => {
  it('does not destroy the window or its DevTools attachment when the native close fires', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()
    const hostWindow = lastWindow()

    ;(hostWindow.close as unknown as () => void)()

    expect(hostWindow.isDestroyed()).toBe(false)
    expect(hostWindow.hide).toHaveBeenCalledTimes(1)
  })

  it('reopening after a close just re-shows the SAME window — no rebuild, no re-attach', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()
    const firstWindow = lastWindow()
    const countAfterFirst = stubs.browserWindows.length

    ;(firstWindow.close as unknown as () => void)()
    ctrl.open()

    expect(stubs.browserWindows.length).toBe(countAfterFirst)
    expect(lastWindow()).toBe(firstWindow)
    expect(targetStub.webContents.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(targetStub.webContents.openDevTools).toHaveBeenCalledTimes(1)
    expect(firstWindow.show).toHaveBeenCalledTimes(2)
    expect(firstWindow.focus).toHaveBeenCalledTimes(2)
  })
})

describe('createInternalDevtoolsWindow.dispose()', () => {
  it('destroys the window when one is open', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()
    const hostWindow = lastWindow()

    ctrl.dispose()

    expect(hostWindow.destroy).toHaveBeenCalled()
    expect(hostWindow.isDestroyed()).toBe(true)
  })

  it('is a no-op that does not throw when open() was never called', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    expect(() => ctrl.dispose()).not.toThrow()
  })

  it('a later open() after dispose() rebuilds a fresh window and re-attaches', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    ctrl.open()
    const firstWindow = lastWindow()
    const countAfterFirst = stubs.browserWindows.length
    ctrl.dispose()

    ctrl.open()

    expect(stubs.browserWindows.length).toBe(countAfterFirst + 1)
    const secondWindow = lastWindow()
    expect(secondWindow).not.toBe(firstWindow)
    expect(targetStub.webContents.setDevToolsWebContents).toHaveBeenCalledTimes(2)
    expect(targetStub.webContents.openDevTools).toHaveBeenCalledTimes(2)
  })
})

describe('createInternalDevtoolsWindow: target already destroyed', () => {
  it('open() does not throw when target.webContents.isDestroyed() is true', () => {
    vi.spyOn(target.webContents, 'isDestroyed').mockReturnValue(true)
    const ctrl = createInternalDevtoolsWindow(target)

    expect(() => ctrl.open()).not.toThrow()
  })
})
