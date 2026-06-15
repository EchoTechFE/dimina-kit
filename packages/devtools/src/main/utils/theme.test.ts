/**
 * Tests for `installThemeBackgroundSync`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted stubs (must be hoisted so vi.mock factory can close over them) ──
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown

  function makeEmitter() {
    const listeners: Record<string, Set<AnyFn>> = {}
    return {
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...args: unknown[]) => {
          listeners[event]?.delete(wrap)
          return fn(...args)
        }
        ;(listeners[event] ??= new Set()).add(wrap)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
      // Test-only: drop every listener so each test starts from a clean
      // emitter. `nativeTheme` is a hoisted singleton shared across tests,
      // so without this, listeners from earlier tests leak into later ones.
      removeAllListeners() {
        for (const key of Object.keys(listeners)) delete listeners[key]
      },
    }
  }

  // nativeTheme is a shared singleton that tests mutate between assertions.
  const nativeThemeEmitter = makeEmitter()
  const nativeTheme = {
    ...nativeThemeEmitter,
    shouldUseDarkColors: false as boolean,
  }

  // Mutable list of windows returned by BrowserWindow.getAllWindows()
  const windows: Array<{ setBackgroundColor: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }> = []

  return { makeEmitter, nativeTheme, windows }
})

// ── Mock electron ──────────────────────────────────────────────────────────
vi.mock('electron', () => {
  const BrowserWindow = {
    getAllWindows: () => stubs.windows,
  }
  return {
    nativeTheme: stubs.nativeTheme,
    BrowserWindow,
    default: {},
  }
})

// ── Helper: build a fake BrowserWindow ────────────────────────────────────
function makeFakeWindow(opts: { destroyed?: boolean } = {}) {
  let destroyed = opts.destroyed ?? false
  return {
    setBackgroundColor: vi.fn(),
    // installThemeBackgroundSync also pushes the resolved isDark to each live
    // window's renderer (so JS consumers like Monaco can re-theme).
    webContents: { send: vi.fn(), isDestroyed: () => destroyed },
    isDestroyed: () => destroyed,
    setDestroyed(val: boolean) { destroyed = val },
  }
}

// ── Import under test (lazy so mock is in place first) ────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let installThemeBackgroundSync: (...args: any[]) => any

beforeEach(async () => {
  vi.resetModules()
  // Reset shared nativeTheme state
  stubs.nativeTheme.shouldUseDarkColors = false
  // Drop listeners accumulated by previous tests (shared hoisted singleton)
  stubs.nativeTheme.removeAllListeners()
  // Clear the window list
  stubs.windows.length = 0
  // Re-import so module cache is fresh (no listener accumulation across tests)
  const mod = await import('./theme.js')
  installThemeBackgroundSync = (mod as Record<string, unknown>)['installThemeBackgroundSync'] as typeof installThemeBackgroundSync
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('installThemeBackgroundSync', () => {
  it('test 1 – dark theme: emitting updated calls setBackgroundColor(#1a1a1a) on a window', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')

    expect(win.setBackgroundColor).toHaveBeenCalledWith('#1a1a1a')
  })

  it('test 2 – light theme: emitting updated calls setBackgroundColor(#fafafa) on a window', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = false
    stubs.nativeTheme.emit('updated')

    expect(win.setBackgroundColor).toHaveBeenCalledWith('#fafafa')
  })

  it('test 3 – multiple windows: emitting updated syncs every window with the correct color', async () => {
    const winA = makeFakeWindow()
    const winB = makeFakeWindow()
    const winC = makeFakeWindow()
    stubs.windows.push(winA, winB, winC)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')

    expect(winA.setBackgroundColor).toHaveBeenCalledWith('#1a1a1a')
    expect(winB.setBackgroundColor).toHaveBeenCalledWith('#1a1a1a')
    expect(winC.setBackgroundColor).toHaveBeenCalledWith('#1a1a1a')
  })

  it('test 4 – destroyed window skipped: setBackgroundColor is NOT called on it but IS called on live windows', async () => {
    const liveWin = makeFakeWindow({ destroyed: false })
    const deadWin = makeFakeWindow({ destroyed: true })
    stubs.windows.push(liveWin, deadWin)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')

    expect(deadWin.setBackgroundColor).not.toHaveBeenCalled()
    expect(liveWin.setBackgroundColor).toHaveBeenCalledWith('#1a1a1a')
  })

  it('test 5 – color re-read each event: two successive events with flipped shouldUseDarkColors produce two up-to-date colors', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')

    stubs.nativeTheme.shouldUseDarkColors = false
    stubs.nativeTheme.emit('updated')

    expect(win.setBackgroundColor).toHaveBeenCalledTimes(2)
    expect(win.setBackgroundColor).toHaveBeenNthCalledWith(1, '#1a1a1a')
    expect(win.setBackgroundColor).toHaveBeenNthCalledWith(2, '#fafafa')
  })

  it('test 6 – no synchronous call: installThemeBackgroundSync() does not call setBackgroundColor before any updated event fires', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    installThemeBackgroundSync()

    // No updated event fired yet
    expect(win.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('test 7 – after dispose(): subsequent updated fires no setBackgroundColor; calling dispose() twice does not throw', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    const disposable = installThemeBackgroundSync()

    // First dispose — should not throw
    expect(() => disposable.dispose()).not.toThrow()

    // Second dispose — idempotent, should not throw
    expect(() => disposable.dispose()).not.toThrow()

    // Now fire the event — nothing should happen
    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')

    expect(win.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('test 8 – empty window list: emitting updated does not throw', async () => {
    // stubs.windows is already empty from beforeEach

    installThemeBackgroundSync()

    expect(() => {
      stubs.nativeTheme.shouldUseDarkColors = true
      stubs.nativeTheme.emit('updated')
    }).not.toThrow()
  })

  it('test 9 – broadcasts the resolved isDark to each live window so JS consumers (Monaco) can re-theme', async () => {
    const win = makeFakeWindow()
    stubs.windows.push(win)

    installThemeBackgroundSync()

    stubs.nativeTheme.shouldUseDarkColors = true
    stubs.nativeTheme.emit('updated')
    expect(win.webContents.send).toHaveBeenLastCalledWith('workbenchSettings:themeChanged', true)

    stubs.nativeTheme.shouldUseDarkColors = false
    stubs.nativeTheme.emit('updated')
    expect(win.webContents.send).toHaveBeenLastCalledWith('workbenchSettings:themeChanged', false)
  })
})

describe('simDeskBg', () => {
  it('returns the dark desk in dark mode and a neutral light grey in light mode', async () => {
    const mod = await import('./theme.js')
    const simDeskBg = (mod as Record<string, unknown>)['simDeskBg'] as () => string

    stubs.nativeTheme.shouldUseDarkColors = true
    expect(simDeskBg()).toBe('#121212')

    stubs.nativeTheme.shouldUseDarkColors = false
    expect(simDeskBg()).toBe('#e8e8e8')
  })
})
