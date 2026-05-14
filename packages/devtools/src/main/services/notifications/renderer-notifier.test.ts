/**
 * Verifies that `RendererNotifier` no-ops every send method once the target
 * WebContents (or its hosting BrowserWindow / sub view) is destroyed, and
 * never throws.
 *
 * Covers three target classes:
 *   - main window methods (windowNavigateBack, popoverRelaunch, projectStatus,
 *     toolbarActionsChanged) → routed via `ctx.mainWindow.webContents.send`
 *   - settings overlay (settingsInit) → routed via
 *     `ctx.views.getSettingsWebContents().send`
 *   - popoverInit takes a separate view argument; flipping its
 *     `webContents.isDestroyed()` must also short-circuit the send
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  WindowChannel,
  PopoverChannel,
  ProjectChannel,
  ToolbarChannel,
  SettingsChannel,
} from '../../../shared/ipc-channels.js'
import { createRendererNotifier } from './renderer-notifier.js'

function makeWebContents() {
  return {
    destroyed: false,
    send: vi.fn(),
    isDestroyed() { return this.destroyed },
  }
}

function makeBrowserWindow() {
  const wc = makeWebContents()
  return {
    destroyed: false,
    webContents: wc,
    isDestroyed() { return this.destroyed },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RendererNotifier — destroyed targets no-op', () => {
  it('windowNavigateBack: sends while alive, no-ops after mainWindow is destroyed', () => {
    const mainWindow = makeBrowserWindow()
    const settingsWc = makeWebContents()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => settingsWc as unknown as Electron.WebContents },
    }
    const notifier = createRendererNotifier(ctx)

    notifier.windowNavigateBack()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(WindowChannel.NavigateBack)

    // Tear the window down: notifier must short-circuit at the BrowserWindow.isDestroyed gate.
    mainWindow.destroyed = true
    expect(() => notifier.windowNavigateBack()).not.toThrow()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('windowNavigateBack: no-ops once only the webContents is destroyed (window still alive)', () => {
    const mainWindow = makeBrowserWindow()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => null },
    }
    const notifier = createRendererNotifier(ctx)

    notifier.windowNavigateBack()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

    mainWindow.webContents.destroyed = true
    expect(() => notifier.windowNavigateBack()).not.toThrow()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('popoverRelaunch: sends with payload while alive, no-ops after destruction', () => {
    const mainWindow = makeBrowserWindow()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => null },
    }
    const notifier = createRendererNotifier(ctx)
    const cfg = { foo: 'bar' } as unknown as import('../../../shared/types.js').CompileConfig

    notifier.popoverRelaunch(cfg)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(PopoverChannel.Relaunch, cfg)

    mainWindow.destroyed = true
    notifier.popoverRelaunch(cfg)
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('projectStatus + toolbarActionsChanged: both route through mainWindow and respect destroy', () => {
    const mainWindow = makeBrowserWindow()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => null },
    }
    const notifier = createRendererNotifier(ctx)

    notifier.projectStatus({ status: 'compiling', message: '' })
    notifier.toolbarActionsChanged()
    expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(
      1,
      ProjectChannel.Status,
      { status: 'compiling', message: '' },
    )
    expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(2, ToolbarChannel.ActionsChanged)

    mainWindow.destroyed = true
    notifier.projectStatus({ status: 'idle', message: '' })
    notifier.toolbarActionsChanged()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('settingsInit: targets the settings overlay webContents and no-ops once it is destroyed', () => {
    const mainWindow = makeBrowserWindow()
    const settingsWc = makeWebContents()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: {
        getSettingsWebContents: () =>
          (settingsWc.destroyed ? null : settingsWc) as unknown as Electron.WebContents | null,
      },
    }
    const notifier = createRendererNotifier(ctx)
    const payload = {
      projectPath: '/x',
      config: {} as import('../../../shared/types.js').CompileConfig,
      projectSettings: {} as import('../projects/project-repository.js').ProjectSettings,
    }

    notifier.settingsInit(payload)
    expect(settingsWc.send).toHaveBeenCalledWith(SettingsChannel.Init, payload)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    settingsWc.destroyed = true
    notifier.settingsInit(payload)
    expect(settingsWc.send).toHaveBeenCalledTimes(1)
  })

  it('settingsInit: also no-ops when getSettingsWebContents returns null (overlay hidden)', () => {
    const mainWindow = makeBrowserWindow()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => null },
    }
    const notifier = createRendererNotifier(ctx)
    expect(() =>
      notifier.settingsInit({
        projectPath: '',
        config: {} as import('../../../shared/types.js').CompileConfig,
        projectSettings: {} as import('../projects/project-repository.js').ProjectSettings,
      }),
    ).not.toThrow()
  })

  it('popoverInit: routes via the passed-in popover view; destroyed sub view → no-op', () => {
    const mainWindow = makeBrowserWindow()
    const ctx = {
      mainWindow: mainWindow as unknown as Electron.BrowserWindow,
      views: { getSettingsWebContents: () => null },
    }
    const notifier = createRendererNotifier(ctx)
    const popoverWc = makeWebContents()
    const popoverView = { webContents: popoverWc } as unknown as Electron.WebContentsView

    notifier.popoverInit(popoverView, { hello: 1 })
    expect(popoverWc.send).toHaveBeenCalledWith(PopoverChannel.Init, { hello: 1 })

    popoverWc.destroyed = true
    notifier.popoverInit(popoverView, { hello: 2 })
    expect(popoverWc.send).toHaveBeenCalledTimes(1)
  })
})
