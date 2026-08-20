/**
 * Behavior tests for `createOverlayPanel` (./overlay-panel.js) — the
 * lazy-create/reuse/destroy lifecycle for a main-owned `WebContentsView`
 * overlay (settings sheet, popover, tooltip). Placement itself is delegated
 * to the injected `setDesired`; this suite pins only what the panel owns:
 * native-view creation timing, `pushData` delivery rules (first load vs.
 * reused instance), and `destroy()` teardown safety.
 */
import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebContentsView as ElectronWebContentsView } from 'electron'
import {
  createOverlayPanel,
  type OverlayPanelDeps,
  type OverlayPanelElectron,
} from './overlay-panel.js'

interface FakeWebContents {
  loadFile: ReturnType<typeof vi.fn<(path: string) => void>>
  once: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  close: ReturnType<typeof vi.fn<() => void>>
  id: number
  _fireDidFinishLoad(): void
}

function fakeWebContents(id: number): FakeWebContents {
  let didFinishLoadHandler: (() => void) | undefined
  let destroyed = false
  return {
    loadFile: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'did-finish-load') didFinishLoadHandler = handler
    }),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => {
      destroyed = true
    }),
    id,
    _fireDidFinishLoad() {
      didFinishLoadHandler?.()
    },
  }
}

function fakeView(webContents: FakeWebContents) {
  return {
    webContents: webContents as unknown as WebContents,
    setBackgroundColor: vi.fn(),
  } as unknown as ElectronWebContentsView & { setBackgroundColor: ReturnType<typeof vi.fn> }
}

let nextId = 1
function makeElectron(): { electron: OverlayPanelElectron; created: ReturnType<typeof fakeView>[] } {
  const created: ReturnType<typeof fakeView>[] = []
  const electron: OverlayPanelElectron = {
    createWebContentsView: vi.fn((_opts) => {
      const view = fakeView(fakeWebContents(nextId++))
      created.push(view)
      return view
    }),
  }
  return { electron, created }
}

function baseDeps<TShowData>(
  overrides: Partial<OverlayPanelDeps<TShowData>> = {},
): { deps: OverlayPanelDeps<TShowData>; electron: OverlayPanelElectron; created: ReturnType<typeof fakeView>[]; setDesired: ReturnType<typeof vi.fn>; registerView: ReturnType<typeof vi.fn> } {
  const { electron, created } = makeElectron()
  const setDesired = vi.fn()
  const registerView = vi.fn()
  const deps: OverlayPanelDeps<TShowData> = {
    electron,
    rendererDir: '/app/dist/renderer',
    entry: 'entries/tooltip/index.html',
    webPreferences: { preload: '/app/preload.js' },
    setDesired,
    registerView,
    ...overrides,
  }
  return { deps, electron, created, setDesired, registerView }
}

describe('createOverlayPanel', () => {
  it('registers a view getter at construction, before any show()', () => {
    const { deps, registerView } = baseDeps()
    createOverlayPanel(deps)
    expect(registerView).toHaveBeenCalledTimes(1)
    const getView = registerView.mock.calls[0]![0] as () => unknown
    expect(getView()).toBeNull()
  })

  it('isPresent() is false before the first show()', () => {
    const { deps } = baseDeps()
    const panel = createOverlayPanel(deps)
    expect(panel.isPresent()).toBe(false)
  })

  describe('show()', () => {
    it('lazily creates the native view on first call: webPreferences, hardenNavigation, background, loadFile(rendererDir/entry)', () => {
      const hardenNavigation = vi.fn()
      const { deps, electron, created } = baseDeps({ hardenNavigation })
      const panel = createOverlayPanel(deps)

      panel.show(undefined, { x: 1, y: 2, width: 3, height: 4 })

      expect(electron.createWebContentsView).toHaveBeenCalledTimes(1)
      expect(electron.createWebContentsView).toHaveBeenCalledWith({ webPreferences: deps.webPreferences })
      expect(hardenNavigation).toHaveBeenCalledTimes(1)
      expect(hardenNavigation).toHaveBeenCalledWith(created[0]!.webContents)
      expect(created[0]!.setBackgroundColor).toHaveBeenCalledWith('#00000000')
      expect(created[0]!.webContents.loadFile).toHaveBeenCalledWith('/app/dist/renderer/entries/tooltip/index.html')
      expect(panel.isPresent()).toBe(true)
    })

    it('honors a custom backgroundColor instead of the transparent default', () => {
      const { deps, created } = baseDeps({ backgroundColor: '#112233ff' })
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      expect(created[0]!.setBackgroundColor).toHaveBeenCalledWith('#112233ff')
    })

    it('reuses the live instance on a second show() (no second createWebContentsView call)', () => {
      const { deps, electron } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      panel.show(undefined, { x: 5, y: 5, width: 1, height: 1 })
      expect(electron.createWebContentsView).toHaveBeenCalledTimes(1)
    })

    it('calls setDesired(bounds) on every show(), including reuses', () => {
      const { deps, setDesired } = baseDeps()
      const panel = createOverlayPanel(deps)
      const b1 = { x: 0, y: 0, width: 1, height: 1 }
      const b2 = { x: 5, y: 5, width: 2, height: 2 }
      panel.show(undefined, b1)
      panel.show(undefined, b2)
      expect(setDesired).toHaveBeenNthCalledWith(1, b1)
      expect(setDesired).toHaveBeenNthCalledWith(2, b2)
    })

    it('defers pushData until did-finish-load on a freshly-created view', () => {
      const pushData = vi.fn()
      const { deps, created } = baseDeps<{ msg: string }>({ pushData })
      const panel = createOverlayPanel(deps)

      panel.show({ msg: 'hello' }, { x: 0, y: 0, width: 1, height: 1 })
      expect(pushData).not.toHaveBeenCalled()

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFinishLoad()
      expect(pushData).toHaveBeenCalledTimes(1)
      expect(pushData).toHaveBeenCalledWith(created[0], { msg: 'hello' })
    })

    it('pushes data immediately (no did-finish-load wait) on a reused instance', () => {
      const pushData = vi.fn()
      const { deps, created } = baseDeps<{ msg: string }>({ pushData })
      const panel = createOverlayPanel(deps)

      panel.show({ msg: 'first' }, { x: 0, y: 0, width: 1, height: 1 })
      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFinishLoad()
      pushData.mockClear()

      panel.show({ msg: 'second' }, { x: 0, y: 0, width: 1, height: 1 })
      expect(pushData).toHaveBeenCalledTimes(1)
      expect(pushData).toHaveBeenCalledWith(created[0], { msg: 'second' })
    })

    it('does not throw when pushData is not provided', () => {
      const { deps } = baseDeps()
      const panel = createOverlayPanel(deps)
      expect(() => panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })).not.toThrow()
    })

    it('works without an hardenNavigation dep', () => {
      const { deps } = baseDeps()
      const panel = createOverlayPanel(deps)
      expect(() => panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })).not.toThrow()
    })
  })

  describe('reposition()', () => {
    it('is a no-op if the view was never shown', () => {
      const { deps, setDesired } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.reposition({ x: 1, y: 1, width: 1, height: 1 })
      expect(setDesired).not.toHaveBeenCalled()
    })

    it('calls setDesired(bounds) once the view exists', () => {
      const { deps, setDesired } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      setDesired.mockClear()
      panel.reposition({ x: 9, y: 9, width: 9, height: 9 })
      expect(setDesired).toHaveBeenCalledTimes(1)
      expect(setDesired).toHaveBeenCalledWith({ x: 9, y: 9, width: 9, height: 9 })
    })
  })

  describe('hide()', () => {
    it('is a no-op if the view was never shown', () => {
      const { deps, setDesired } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.hide()
      expect(setDesired).not.toHaveBeenCalled()
    })

    it('calls setDesired(null) once the view exists, keeping the native view alive', () => {
      const { deps, setDesired, electron } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      setDesired.mockClear()
      panel.hide()
      expect(setDesired).toHaveBeenCalledWith(null)
      expect(panel.isPresent()).toBe(true)
      expect(electron.createWebContentsView).toHaveBeenCalledTimes(1)
    })
  })

  describe('getWebContents() / getWebContentsId()', () => {
    it('return null before the view exists', () => {
      const { deps } = baseDeps()
      const panel = createOverlayPanel(deps)
      expect(panel.getWebContents()).toBeNull()
      expect(panel.getWebContentsId()).toBeNull()
    })

    it('return the live webContents/id once shown', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      expect(panel.getWebContents()).toBe(created[0]!.webContents)
      expect(panel.getWebContentsId()).toBe((created[0]!.webContents as unknown as FakeWebContents).id)
    })

    it('return null once the underlying webContents reports destroyed', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      ;(created[0]!.webContents as unknown as FakeWebContents).close()
      expect(panel.getWebContents()).toBeNull()
      expect(panel.getWebContentsId()).toBeNull()
    })
  })

  describe('destroy()', () => {
    function fakeMainWindow(destroyed = false) {
      const removeChildView = vi.fn()
      const raw = {
        isDestroyed: () => destroyed,
        contentView: { removeChildView },
      }
      return { mainWindow: raw as unknown as BrowserWindow, removeChildView }
    }

    it('is a no-op if the view was never shown', () => {
      const { deps } = baseDeps()
      const panel = createOverlayPanel(deps)
      const { mainWindow, removeChildView } = fakeMainWindow()
      expect(() => panel.destroy(mainWindow)).not.toThrow()
      expect(removeChildView).not.toHaveBeenCalled()
    })

    it('removes the child view and closes webContents, then isPresent() is false', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      const { mainWindow, removeChildView } = fakeMainWindow()

      panel.destroy(mainWindow)

      expect(removeChildView).toHaveBeenCalledWith(created[0])
      expect((created[0]!.webContents as unknown as FakeWebContents).close).toHaveBeenCalledTimes(1)
      expect(panel.isPresent()).toBe(false)
    })

    it('skips removeChildView when mainWindow is already destroyed, but still closes webContents', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      const { mainWindow, removeChildView } = fakeMainWindow(true)

      panel.destroy(mainWindow)

      expect(removeChildView).not.toHaveBeenCalled()
      expect((created[0]!.webContents as unknown as FakeWebContents).close).toHaveBeenCalledTimes(1)
    })

    it('swallows a removeChildView throw (view already removed elsewhere)', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      const { mainWindow, removeChildView } = fakeMainWindow()
      removeChildView.mockImplementation(() => {
        throw new Error('already removed')
      })

      expect(() => panel.destroy(mainWindow)).not.toThrow()
      expect((created[0]!.webContents as unknown as FakeWebContents).close).toHaveBeenCalledTimes(1)
    })

    it('does not call close() again if webContents is already destroyed', () => {
      const { deps, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      ;(created[0]!.webContents as unknown as FakeWebContents).close()
      const closeSpy = (created[0]!.webContents as unknown as FakeWebContents).close
      closeSpy.mockClear()
      const { mainWindow } = fakeMainWindow()

      panel.destroy(mainWindow)

      expect(closeSpy).not.toHaveBeenCalled()
    })

    it('lets the next show() create a brand-new instance (fresh load, no state)', () => {
      const { deps, electron, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      panel.destroy(fakeMainWindow().mainWindow)

      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      expect(electron.createWebContentsView).toHaveBeenCalledTimes(2)
      expect(created).toHaveLength(2)
      expect(created[1]).not.toBe(created[0])
    })
  })
})
