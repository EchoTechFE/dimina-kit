/**
 * Behavior tests for `createOverlayPanel` (./overlay-panel.js) — the
 * lazy-create/reuse/destroy lifecycle for a main-owned `WebContentsView`
 * overlay (settings sheet, popover, tooltip). Placement itself is delegated
 * to the injected `setDesired`; this suite pins only what the panel owns:
 * native-view creation timing, `pushData` delivery rules (first load vs.
 * reused instance), and `destroy()` teardown safety.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebContents, WebContentsView as ElectronWebContentsView } from 'electron'
import {
  createOverlayPanel,
  type OverlayPanelDeps,
  type OverlayPanelElectron,
} from './overlay-panel.js'

interface FakeWebContents {
  loadFile: ReturnType<typeof vi.fn<(path: string) => void>>
  once: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>
  on: ReturnType<typeof vi.fn<(event: string, handler: (...args: never[]) => void) => void>>
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  close: ReturnType<typeof vi.fn<() => void>>
  id: number
  _fireDidFinishLoad(): void
  _fireDidFailLoad(errorCode: number, isMainFrame: boolean): void
  _fireRenderProcessGone(reason: string): void
}

function fakeWebContents(id: number): FakeWebContents {
  let didFinishLoadHandler: (() => void) | undefined
  let didFailLoadHandler: ((event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void) | undefined
  let renderProcessGoneHandler: ((event: unknown, details: { reason: string }) => void) | undefined
  let destroyed = false
  return {
    loadFile: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'did-finish-load') didFinishLoadHandler = handler
    }),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === 'did-fail-load') didFailLoadHandler = handler as typeof didFailLoadHandler
      if (event === 'render-process-gone') renderProcessGoneHandler = handler as typeof renderProcessGoneHandler
    }),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => {
      destroyed = true
    }),
    id,
    _fireDidFinishLoad() {
      didFinishLoadHandler?.()
    },
    _fireDidFailLoad(errorCode, isMainFrame) {
      didFailLoadHandler?.(undefined, errorCode, 'failed', 'file:///x', isMainFrame)
    },
    _fireRenderProcessGone(reason) {
      renderProcessGoneHandler?.(undefined, { reason })
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
): { deps: OverlayPanelDeps<TShowData>; electron: OverlayPanelElectron; created: ReturnType<typeof fakeView>[]; setDesired: ReturnType<typeof vi.fn>; registerView: ReturnType<typeof vi.fn>; destroyView: ReturnType<typeof vi.fn> } {
  const { electron, created } = makeElectron()
  const setDesired = vi.fn()
  const registerView = vi.fn()
  const destroyView = vi.fn((view: ElectronWebContentsView) => {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  })
  const deps: OverlayPanelDeps<TShowData> = {
    electron,
    rendererDir: '/app/dist/renderer',
    entry: 'entries/tooltip/index.html',
    webPreferences: { preload: '/app/preload.js' },
    setDesired,
    registerView,
    destroyView,
    ...overrides,
  }
  return { deps, electron, created, setDesired, registerView, destroyView }
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

    it('delivers only the latest data when show() is called again before the renderer is ready', () => {
      const pushData = vi.fn()
      const { deps, created } = baseDeps<{ msg: string }>({ pushData })
      const panel = createOverlayPanel(deps)

      panel.show({ msg: 'first' }, { x: 0, y: 0, width: 1, height: 1 })
      panel.show({ msg: 'second' }, { x: 5, y: 5, width: 1, height: 1 })
      expect(pushData).not.toHaveBeenCalled()

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFinishLoad()
      expect(pushData).toHaveBeenCalledTimes(1)
      expect(pushData).toHaveBeenCalledWith(created[0], { msg: 'second' })
    })

    it('pushes data immediately (no did-finish-load wait) on a ready reused instance', () => {
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

    it('replaces an externally destroyed instance on the next show()', () => {
      const { deps, electron, created } = baseDeps()
      const panel = createOverlayPanel(deps)

      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      ;(created[0]!.webContents as unknown as FakeWebContents).close()
      panel.show(undefined, { x: 1, y: 1, width: 2, height: 2 })

      expect(electron.createWebContentsView).toHaveBeenCalledTimes(2)
      expect(created[1]).not.toBe(created[0])
    })

    it('waits for an explicit renderer acknowledgement in manual ready mode', async () => {
      const pushData = vi.fn()
      const { deps, created, setDesired } = baseDeps<{ msg: string }>({
        pushData,
        readyMode: 'manual',
      })
      const panel = createOverlayPanel(deps)
      const ready = panel.whenReady()

      panel.show({ msg: 'latest' }, { x: 1, y: 2, width: 3, height: 4 })
      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFinishLoad()
      expect(pushData).not.toHaveBeenCalled()
      expect(setDesired).not.toHaveBeenCalled()

      panel.markReady((created[0]!.webContents as unknown as FakeWebContents).id)
      await ready
      expect(pushData).toHaveBeenCalledWith(created[0], { msg: 'latest' })
      expect(setDesired).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 })
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
    it('is a no-op if the view was never shown', () => {
      const { deps, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      expect(() => panel.destroy()).not.toThrow()
      expect(destroyView).not.toHaveBeenCalled()
    })

    it('delegates teardown to the host owner and clears presence', () => {
      const { deps, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      panel.destroy()

      expect(destroyView).toHaveBeenCalledWith(created[0])
      expect((created[0]!.webContents as unknown as FakeWebContents).close).toHaveBeenCalledTimes(1)
      expect(panel.isPresent()).toBe(false)
    })

    it('lets the next show() create a brand-new instance', () => {
      const { deps, electron, created } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      panel.destroy()

      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      expect(electron.createWebContentsView).toHaveBeenCalledTimes(2)
      expect(created).toHaveLength(2)
      expect(created[1]).not.toBe(created[0])
    })
  })

  describe('crash/failed-load recovery', () => {
    // BUG CAUGHT: `ensureView()`'s reuse check only asks
    // `!webContents.isDestroyed()` — a renderer crash or a failed navigation
    // leaves `webContents` non-destroyed but blank/unresponsive, so without
    // this recovery path the SAME broken view would be handed back to every
    // future show() forever, especially fatal for a `readyMode: 'manual'`
    // panel (ProjectCreateDialog/UpdateDialog) whose only unblock signal is a
    // renderer-sent markReady() that can now never arrive.

    it('render-process-gone destroys the view and lets the next show() build a fresh instance', () => {
      const { deps, electron, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireRenderProcessGone('crashed')

      expect(destroyView).toHaveBeenCalledWith(created[0])
      expect(panel.isPresent()).toBe(false)

      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      expect(electron.createWebContentsView).toHaveBeenCalledTimes(2)
      expect(created[1]).not.toBe(created[0])
    })

    it('a main-frame did-fail-load with a real error code destroys the view and lets the next show() build a fresh instance', () => {
      const { deps, electron, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFailLoad(-6, true)

      expect(destroyView).toHaveBeenCalledWith(created[0])
      expect(panel.isPresent()).toBe(false)

      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      expect(electron.createWebContentsView).toHaveBeenCalledTimes(2)
    })

    it('ignores ERR_ABORTED (-3) — a fresh loadFile/loadURL superseding this one is routine, not a crash', () => {
      const { deps, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFailLoad(-3, true)

      expect(destroyView).not.toHaveBeenCalled()
      expect(panel.isPresent()).toBe(true)
    })

    it('ignores a did-fail-load on a subframe', () => {
      const { deps, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireDidFailLoad(-6, false)

      expect(destroyView).not.toHaveBeenCalled()
      expect(panel.isPresent()).toBe(true)
    })

    it('resolves a pending whenReady() instead of hanging forever when a manual-readyMode view crashes before markReady()', async () => {
      const { deps, created } = baseDeps({ readyMode: 'manual' })
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      const ready = panel.whenReady()

      ;(created[0]!.webContents as unknown as FakeWebContents)._fireRenderProcessGone('crashed')

      await expect(ready).resolves.toBeUndefined()
    })

    it('a crash event on an already-destroy()ed instance is a no-op (stale-epoch guard)', () => {
      const { deps, created, destroyView } = baseDeps()
      const panel = createOverlayPanel(deps)
      panel.show(undefined, { x: 0, y: 0, width: 1, height: 1 })
      const firstView = created[0]!
      panel.destroy()
      destroyView.mockClear()

      ;(firstView.webContents as unknown as FakeWebContents)._fireRenderProcessGone('late crash')

      expect(destroyView).not.toHaveBeenCalled()
    })
  })
})
