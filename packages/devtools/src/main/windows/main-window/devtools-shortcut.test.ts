/**
 * DEVTOOLS SHORTCUT OWNERSHIP (CommandOrControl+Shift+I) across windows.
 *
 * `globalShortcut` is process-wide: registering the same accelerator twice is
 * refused by Electron, so a per-window registration would hand the shortcut
 * permanently to whichever window wired up first. Every other window's press
 * would then open THAT window's DevTools — and when the owning window closed
 * and unregistered, the accelerator would go dead for the windows still open.
 *
 * Invariant: one process-wide registration, shared by every window, whose
 * target is resolved at press time from the focused window. It survives any
 * single window's disposal and is released only when the last one goes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  registered: new Map<string, () => void>(),
  registerCalls: [] as string[],
  unregisterCalls: [] as string[],
  focused: null as unknown,
}))

vi.mock('electron', () => {
  const globalShortcut = {
    // Mirrors Electron: a second register() of a live accelerator fails.
    register: vi.fn((accelerator: string, callback: () => void) => {
      stubs.registerCalls.push(accelerator)
      if (stubs.registered.has(accelerator)) return false
      stubs.registered.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      stubs.unregisterCalls.push(accelerator)
      stubs.registered.delete(accelerator)
    }),
    unregisterAll: vi.fn(() => {
      stubs.registered.clear()
    }),
  }
  class BrowserWindow {
    static getFocusedWindow = vi.fn(() => stubs.focused)
  }
  return { globalShortcut, BrowserWindow, default: {} }
})

const ACCELERATOR = 'CommandOrControl+Shift+I'

type AnyFn = (...args: unknown[]) => unknown

function makeWindow() {
  const listeners = new Map<string, Set<AnyFn>>()
  return {
    webContents: { openDevTools: vi.fn() },
    contentView: { children: [] as unknown[] },
    getContentSize: () => [800, 600],
    on(event: string, fn: AnyFn) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(fn)
      return this
    },
    removeListener(event: string, fn: AnyFn) {
      listeners.get(event)?.delete(fn)
      return this
    },
  }
}

type FakeWindow = ReturnType<typeof makeWindow>

let wireMainWindowEvents: typeof import('./events.js').wireMainWindowEvents

beforeEach(async () => {
  // Fresh module graph per test: the shortcut's process-wide ownership is
  // module-level state, so it must not leak between cases.
  vi.resetModules()
  stubs.registered.clear()
  stubs.registerCalls.length = 0
  stubs.unregisterCalls.length = 0
  stubs.focused = null
  ;({ wireMainWindowEvents } = await import('./events.js'))
})

function press(): void {
  const callback = stubs.registered.get(ACCELERATOR)
  if (!callback) throw new Error(`${ACCELERATOR} is not registered — nothing would happen on press`)
  callback()
}

function wire(win: FakeWindow) {
  return wireMainWindowEvents(win as unknown as Electron.BrowserWindow, {})
}

describe('DevTools accelerator across multiple windows', () => {
  it('opens the FOCUSED window\'s DevTools, not the window that wired up first', () => {
    const listWindow = makeWindow()
    const projectWindow = makeWindow()
    wire(listWindow)
    wire(projectWindow)

    stubs.focused = projectWindow
    press()

    expect(
      projectWindow.webContents.openDevTools,
      'pressing the shortcut in a project window must open that window\'s DevTools',
    ).toHaveBeenCalledWith({ mode: 'detach' })
    expect(
      listWindow.webContents.openDevTools,
      'the window that happened to wire up first must not capture the shortcut',
    ).not.toHaveBeenCalled()
  })

  it('registers the process-wide accelerator exactly once for many windows', () => {
    wire(makeWindow())
    wire(makeWindow())
    wire(makeWindow())

    expect(
      stubs.registerCalls.filter((a) => a === ACCELERATOR),
      'the accelerator is a process-wide singleton — repeat registrations can only fail',
    ).toHaveLength(1)
  })

  it('keeps the shortcut alive after one window is disposed, and releases it with the last', () => {
    const listWindow = makeWindow()
    const projectWindow = makeWindow()
    const listWiring = wire(listWindow)
    const projectWiring = wire(projectWindow)

    void listWiring.dispose()

    expect(
      stubs.registered.has(ACCELERATOR),
      'a window closing must not strip the shortcut from the windows still open',
    ).toBe(true)
    stubs.focused = projectWindow
    press()
    expect(projectWindow.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })

    void projectWiring.dispose()
    expect(
      stubs.registered.has(ACCELERATOR),
      'the last window releases the process-wide accelerator',
    ).toBe(false)
  })

  it('is a no-op when nothing is focused', () => {
    const win = makeWindow()
    wire(win)
    stubs.focused = null

    expect(() => press()).not.toThrow()
    expect(win.webContents.openDevTools).not.toHaveBeenCalled()
  })
})
