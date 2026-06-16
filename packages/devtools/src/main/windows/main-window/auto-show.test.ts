/**
 * autoShow SWITCH (host-shell extensibility) — createMainWindow contract.
 *
 * A host that gates the window behind a login screen needs to create the main
 * window WITHOUT it flashing on screen, then show it itself once auth passes.
 * The framework currently hard-codes `ready-to-show → mainWindow.show()`.
 *
 * Contract:
 *  - `WindowOptions.autoShow?: boolean` (default treated as `true`).
 *  - Visibility is decided by autoShow in BOTH envs; env only decides HOW the
 *    window is revealed (production → `show()`, test → `showInactive()` to
 *    avoid stealing focus during e2e).
 *  - Non-test env (`NODE_ENV !== 'test'`): when `autoShow === false`, the
 *    `ready-to-show` handler must NOT call `mainWindow.show()`.
 *  - test env (`NODE_ENV === 'test'`): when `autoShow === false`, the handler
 *    must call NEITHER `show()` NOR `showInactive()` — a login-gated host owns
 *    the reveal even under test; the framework must not force an un-authed
 *    window visible.
 *  - `autoShow` omitted or `true`: window is revealed (non-test → `show()`,
 *    test → `showInactive()`).
 *
 * Bug guarded against: framework ignores autoShow and shows the window on
 * ready-to-show, so the login-gate host gets a visible un-authed window flash.
 *
 * Harness: mock electron, capture the `once('ready-to-show', cb)` callback,
 * fire it manually, assert show()/showInactive() were / were not called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const readyCbs = vi.hoisted(() => ({ list: [] as Array<() => void> }))

vi.mock('electron', () => {
  const app = { isPackaged: true }

  class WebContents {
    id = Math.floor(Math.random() * 1e6)
    setWindowOpenHandler = vi.fn()
    on = vi.fn()
    once = vi.fn()
    openDevTools = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
  }

  class View {
    children: View[] = []
    addChildView(child: View) { this.children.push(child) }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
  }

  class WebContentsView extends View {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class BrowserWindow {
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    show = vi.fn()
    showInactive = vi.fn()
    setIcon = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    once = vi.fn((event: string, cb: () => void) => {
      if (event === 'ready-to-show') readyCbs.list.push(cb)
    })
    on = vi.fn()
  }

  const nativeTheme = { themeSource: 'system' }

  return {
    app,
    BrowserWindow,
    View,
    WebContentsView,
    BrowserView: WebContentsView,
    nativeTheme,
    default: {},
  }
})

let createMainWindow: typeof import('./create.js').createMainWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(async () => {
  vi.resetModules()
  readyCbs.list.length = 0
  ;({ createMainWindow } = await import('./create.js'))
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function fireReadyToShow() {
  for (const cb of readyCbs.list) cb()
}

describe('createMainWindow autoShow switch (non-test env)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
  })

  it('autoShow:false → ready-to-show does NOT call show()', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html', autoShow: false })
    fireReadyToShow()
    expect(
      vi.mocked(win.show),
      'a login-gated host passes autoShow:false to keep the un-authed window hidden until it shows it',
    ).not.toHaveBeenCalled()
  })

  it('autoShow omitted → ready-to-show calls show() (default behaviour preserved)', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })
    fireReadyToShow()
    expect(vi.mocked(win.show)).toHaveBeenCalledTimes(1)
  })

  it('autoShow:true → ready-to-show calls show()', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html', autoShow: true })
    fireReadyToShow()
    expect(vi.mocked(win.show)).toHaveBeenCalledTimes(1)
  })
})

describe('createMainWindow autoShow is honoured in test env (env only selects show vs showInactive)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
  })

  it('test env + autoShow:false → calls NEITHER show() NOR showInactive()', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html', autoShow: false })
    fireReadyToShow()
    expect(
      vi.mocked(win.showInactive),
      'a login-gated host owns the reveal under test too — the framework must not force an un-authed window visible',
    ).not.toHaveBeenCalled()
    expect(vi.mocked(win.show)).not.toHaveBeenCalled()
  })

  it('test env + autoShow omitted → calls showInactive() once, never show()', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })
    fireReadyToShow()
    expect(
      vi.mocked(win.showInactive),
      'test env reveals via showInactive (avoids stealing focus during e2e)',
    ).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.show)).not.toHaveBeenCalled()
  })

  it('test env + autoShow:true → calls showInactive() once, never show()', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html', autoShow: true })
    fireReadyToShow()
    expect(vi.mocked(win.showInactive)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.show)).not.toHaveBeenCalled()
  })
})
