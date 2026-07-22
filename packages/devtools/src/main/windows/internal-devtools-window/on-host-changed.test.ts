/**
 * `createInternalDevtoolsWindow(target).onHostChanged(handler)` — the
 * subscription that lets callers (app.ts wiring) learn about the front-end
 * host's VISIBILITY (not its build/destroy lifecycle — see index.ts's module
 * doc for why the DevTools attachment is built once and never rebuilt) so
 * they can mirror it elsewhere (e.g. `NetworkForwarder.setGlobalDevtoolsHost`).
 *
 * Invariants under test:
 *  - the FIRST `.open()` (window built + attached) fires every subscriber
 *    once with the host's webContents;
 *  - a reuse `.open()` while the window is ALREADY visible still fires again
 *    with the SAME host webContents (a repeat "show" click legitimately
 *    re-triggers a replay-catchup in downstream consumers — see
 *    open-gated-relay.ts's WeakMap dedup, which makes this safe);
 *  - the window's native close (hide, not destroy) fires subscribers once
 *    with `null`;
 *  - `.open()` after a close (hide) fires again with the SAME host
 *    webContents (not a new object — no rebuild happened);
 *  - multiple subscribers all observe the same event;
 *  - `.dispose()` on a live window fires handler(null);
 *  - a later `.open()` after `.dispose()` rebuilds and fires with a NEW host
 *    webContents (a real rebuild — dispose() is the one path that actually
 *    destroys the attachment);
 *  - the returned unsubscribe function stops only that handler, not others.
 *
 * Electron mock: copied from ./index.test.ts (trimmed BrowserWindow /
 * WebContentsView / View stubs) — this is a focused unit test of the window
 * controller alone, no full createDevtoolsRuntime assembly (that lives in
 * ../../app/internal-devtools-global-network-wiring.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { createInternalDevtoolsWindow } from './index.js'

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

interface StubView {
  children: { webContents: unknown }[]
}
interface StubBrowserWindow {
  contentView: StubView
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

let target: BrowserWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  stubs.reset()
  target = new BrowserWindow()
  // Exercise the PRODUCTION show()+focus() path — vitest's own ambient
  // NODE_ENV=test would otherwise divert open() into showInactive() (see
  // test-mode-show-inactive.test.ts for coverage of THAT branch). Mirrors
  // main-window/auto-show.test.ts's established save/restore pattern.
  process.env.NODE_ENV = 'production'
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function lastWindow(): StubBrowserWindow {
  return stubs.browserWindows[stubs.browserWindows.length - 1] as StubBrowserWindow
}

function hostWcOf(win: StubBrowserWindow): unknown {
  return win.contentView.children[0].webContents
}

describe('createInternalDevtoolsWindow.onHostChanged: fresh build', () => {
  it('fires the handler once with the new host webContents on first open()', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)

    ctrl.open()

    const hostWc = hostWcOf(lastWindow())
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(hostWc)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: reuse open() while visible', () => {
  it('fires again with the SAME host webContents (a repeat show is safe — dedup lives downstream)', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)
    ctrl.open()
    const hostWc = hostWcOf(lastWindow())
    handler.mockClear()

    ctrl.open()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(hostWc)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: close hides (not destroys)', () => {
  it('fires the handler once with null when the native close fires', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)
    ctrl.open()
    handler.mockClear()

    ;(lastWindow().close as unknown as () => void)()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(null)
  })

  it('reopening after a close fires again with the SAME host webContents — no rebuild', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)
    ctrl.open()
    const firstHostWc = hostWcOf(lastWindow())
    ;(lastWindow().close as unknown as () => void)()
    handler.mockClear()

    ctrl.open()

    const secondHostWc = hostWcOf(lastWindow())
    expect(secondHostWc).toBe(firstHostWc)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(firstHostWc)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: multiple subscribers', () => {
  it('both subscribers observe the same open() event', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handlerA = vi.fn()
    const handlerB = vi.fn()
    ctrl.onHostChanged(handlerA)
    ctrl.onHostChanged(handlerB)

    ctrl.open()

    const hostWc = hostWcOf(lastWindow())
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerA).toHaveBeenCalledWith(hostWc)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledWith(hostWc)
  })

  it('still calls a handler registered AFTER one that throws (a broken subscriber must not silently starve later ones)', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const throwing = vi.fn(() => { throw new Error('boom') })
    const after = vi.fn()
    ctrl.onHostChanged(throwing)
    ctrl.onHostChanged(after)

    expect(() => ctrl.open()).not.toThrow()

    const hostWc = hostWcOf(lastWindow())
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledWith(hostWc)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: dispose()', () => {
  it('fires handler(null) when dispose() destroys a live window', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)
    ctrl.open()
    handler.mockClear()

    ctrl.dispose()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(null)
  })

  it('does not fire when dispose() runs and no window was ever opened', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)

    ctrl.dispose()

    expect(handler).not.toHaveBeenCalled()
  })

  it('a later open() after dispose() rebuilds and fires with a NEW host webContents', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handler = vi.fn()
    ctrl.onHostChanged(handler)
    ctrl.open()
    const firstHostWc = hostWcOf(lastWindow())
    ctrl.dispose()
    handler.mockClear()

    ctrl.open()

    const secondHostWc = hostWcOf(lastWindow())
    expect(secondHostWc).not.toBe(firstHostWc)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(secondHostWc)
  })
})

describe('createInternalDevtoolsWindow.onHostChanged: unsubscribe', () => {
  it('stops only the unsubscribed handler, not other still-subscribed handlers', () => {
    const ctrl = createInternalDevtoolsWindow(target)
    const handlerA = vi.fn()
    const handlerB = vi.fn()
    const unsubscribeA = ctrl.onHostChanged(handlerA)
    ctrl.onHostChanged(handlerB)

    unsubscribeA()
    ctrl.open()

    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).toHaveBeenCalledTimes(1)
  })
})
