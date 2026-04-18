import type { WebContents } from 'electron'
import { WebContentsView, webContents } from 'electron'
import path from 'path'
import * as layout from '../layout/index.js'
import { getDefaultTab, type WorkbenchContext } from '../workbench-context.js'

/**
 * Context surface used by the ViewManager. We only need a small slice of the
 * full WorkbenchContext here; typing it this way documents the actual dependency.
 */
export interface ViewManagerContext {
  mainWindow: WorkbenchContext['mainWindow']
  rendererDir: string
  panels: string[]
  notify: WorkbenchContext['notify']
}

/**
 * Unified lifecycle manager for Electron WebContentsView overlays.
 *
 * Owns creation / attachment / detachment / positioning / destruction of
 * every overlay view hung off the main window's contentView (simulator,
 * settings, popover). All `new WebContentsView`, `addChildView`,
 * `removeChildView`, `webContents.destroy()` and overlay `setBounds` calls
 * should live here — IPC handlers just call into the manager.
 *
 * The main window's own renderer (added in `windows/main-window/create.ts`)
 * is the main content root and is not an overlay, so it is not managed here.
 */
export interface ViewManager {
  // ── DevTools ───────────────────────────────────────────────────────────
  /**
   * Create a DevTools view for the given simulator webContents and add it to
   * the main window contentView (only when the `devtools` tab is the default
   * tab; otherwise the view is created but not added yet).
   */
  attachSimulator(simWcId: number, simWidth: number): void
  /**
   * Destroy and null out the simulator view (e.g. on simulator detach).
   * Also destroys the cached settings view and hides the popover —
   * preserves the aggregate `detachAllViews` behaviour of the previous
   * `windows/views.ts` module, which every detach call relied on.
   */
  detachSimulator(): void
  /** Reveal the existing DevTools view (idempotent). */
  showSimulator(simWidth: number): void
  /** Remove (but do not destroy) the simulator view from the contentView. */
  hideSimulator(): void

  // ── Settings (overlay panel on the right) ──────────────────────────────
  /** Lazy-create and show the settings overlay view. */
  showSettings(): Promise<void>
  /** Remove the settings overlay view (kept around for next open). */
  hideSettings(): void

  // ── Popover ────────────────────────────────────────────────────────────
  /** Create and show the popover overlay with the given init payload. */
  showPopover(data: unknown): void
  /** Destroy the popover overlay and notify the renderer. */
  hidePopover(): void

  // ── Aggregate ──────────────────────────────────────────────────────────
  /** Re-apply layout for every currently visible overlay (on window resize). */
  repositionAll(): void
  /** Destroy all overlay webContents and null out the cached views. */
  disposeAll(): void

  // ── Debug ──────────────────────────────────────────────────────────────
  /** Log current child-view count of the main contentView. */
  logChildViews(label: string): void

  // ── Positioning helpers (used by IPC resize handler) ──────────────────
  /** Reposition only the simulator overlay (for simulator width changes). */
  positionSimulator(simWidth: number): void
  /** Reposition only the settings overlay. */
  positionSettings(): void

  // ── State queries ─────────────────────────────────────────────────────
  /** Return the webContents ID of the currently attached simulator. */
  getSimulatorWebContentsId(): number | null
  /** Return the last known simulator width. */
  getLastSimWidth(): number
  /** Whether the simulator overlay is currently added to the contentView. */
  isSimulatorAdded(): boolean
  /** Whether a DevTools view exists (created but maybe not added). */
  hasSimulatorView(): boolean
  /** Return the settings overlay's WebContents (for renderer-notifier). */
  getSettingsWebContents(): WebContents | null

  // ── Compound operations (used by IPC handlers) ────────────────────────
  /** Update lastSimWidth; reposition simulator + settings if they are added. */
  resize(simWidth: number): void
  /** Show or hide the simulator overlay based on visibility flag. */
  setVisible(visible: boolean, simWidth: number): void
}

/**
 * Build a ViewManager bound to the given context. The returned object is the
 * only component allowed to instantiate or add/remove overlay WebContentsViews.
 *
 * All view-related mutable state lives inside this closure and is not exposed
 * on the context object.
 */
export function createViewManager(ctx: ViewManagerContext): ViewManager {
  // ── Private mutable state ───────────────────────────────────────────────
  let simulatorView: WebContentsView | null = null
  let simulatorViewAdded = false
  let settingsView: WebContentsView | null = null
  let settingsViewAdded = false
  let popoverView: WebContentsView | null = null
  let lastSimWidth = 375
  let simulatorWebContentsId: number | null = null

  // ── Internal helpers ────────────────────────────────────────────────────

  function destroyViewInternal(view: WebContentsView | null): void {
    if (!view) return
    if (!ctx.mainWindow.isDestroyed()) {
      try {
        ctx.mainWindow.contentView.removeChildView(view)
      } catch { /* already removed */ }
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    } catch { /* ignore */ }
  }

  function applySimulatorBounds(simWidth: number): void {
    if (!simulatorView || ctx.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.mainWindow.getContentSize()
    simulatorView.setBounds(layout.computeSimulatorBounds(w, h, simWidth))
  }

  function applySettingsBounds(): void {
    if (!settingsView || ctx.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.mainWindow.getContentSize()
    settingsView.setBounds(layout.computeSettingsBounds(w, h))
  }

  function applyPopoverBounds(): void {
    if (!popoverView || ctx.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.mainWindow.getContentSize()
    popoverView.setBounds(layout.computePopoverBounds(w, h))
  }

  // ── ViewManager methods ─────────────────────────────────────────────────

  function attachSimulator(simWcId: number, simWidth: number): void {
    const sim = webContents.fromId(simWcId)
    if (!sim) {
      console.error('[workbench] attachSimulator — simWc not found for id', simWcId)
      return
    }
    lastSimWidth = simWidth
    simulatorWebContentsId = simWcId

    // Destroy old simulatorView to prevent WebContentsView leak
    if (simulatorView) {
      hideSimulator()
      try {
        if (!simulatorView.webContents.isDestroyed()) {
          simulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      simulatorView = null
    }

    simulatorView = new WebContentsView()
    sim.setDevToolsWebContents(simulatorView.webContents)
    sim.openDevTools()

    // Default DevTools to Console panel (Chrome DevTools defaults to Elements).
    // The DevTools UI renders inside simulatorView.webContents; we click the
    // Console tab once its header is laid out, and persist the choice via
    // localStorage so subsequent reloads honor it.
    const devtoolsWc = simulatorView.webContents
    devtoolsWc.once('dom-ready', () => {
      devtoolsWc.executeJavaScript(`
        (function() {
          try { localStorage.setItem('panel-selectedTab', '"console"') } catch {}
          let tries = 0
          const timer = setInterval(() => {
            tries++
            const tabs = document.querySelectorAll('[role="tab"], .tabbed-pane-header-tab')
            for (const tab of tabs) {
              const label = (tab.getAttribute('aria-label') || tab.textContent || '').trim().toLowerCase()
              if (label === 'console' || label.startsWith('console')) {
                tab.click()
                clearInterval(timer)
                return
              }
            }
            if (tries > 40) clearInterval(timer)
          }, 100)
        })()
      `).catch(() => {})
    })

    if (getDefaultTab(ctx) === 'simulator') {
      ctx.mainWindow.contentView.addChildView(simulatorView)
      simulatorViewAdded = true
      applySimulatorBounds(simWidth)
    }
  }

  function detachSimulator(): void {
    hidePopover()
    // Drop the settings view too — the previous detachAllViews() did.
    destroyViewInternal(settingsView)
    settingsView = null
    settingsViewAdded = false
    destroyViewInternal(simulatorView)
    simulatorView = null
    simulatorViewAdded = false
    simulatorWebContentsId = null
  }

  function showSimulator(simWidth: number): void {
    lastSimWidth = simWidth
    if (!simulatorView) return
    if (!simulatorViewAdded) {
      ctx.mainWindow.contentView.addChildView(simulatorView)
      simulatorViewAdded = true
    }
    applySimulatorBounds(simWidth)
  }

  function hideSimulator(): void {
    if (simulatorView && simulatorViewAdded) {
      try {
        ctx.mainWindow.contentView.removeChildView(simulatorView)
      } catch (e) {
        console.error('[workbench] hideSimulator error', e)
      }
      simulatorViewAdded = false
    }
  }

  async function showSettings(): Promise<void> {
    if (!settingsView) {
      settingsView = new WebContentsView({
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      })
      await settingsView.webContents.loadFile(
        path.join(ctx.rendererDir, 'entries/settings/index.html'),
      )
    }
    if (!settingsViewAdded) {
      ctx.mainWindow.contentView.addChildView(settingsView)
      settingsViewAdded = true
    }
    applySettingsBounds()
  }

  function hideSettings(): void {
    if (settingsView && settingsViewAdded) {
      try {
        ctx.mainWindow.contentView.removeChildView(settingsView)
      } catch { /* ignore */ }
      settingsViewAdded = false
    }
  }

  function showPopover(data: unknown): void {
    hidePopover()
    const popover = new WebContentsView({
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    })
    popoverView = popover
    popover.setBackgroundColor('#00000000')
    ctx.mainWindow.contentView.addChildView(popover)
    applyPopoverBounds()
    popover.webContents.once('did-finish-load', () => {
      ctx.notify.popoverInit(popover, data)
    })
    popover.webContents.loadFile(
      path.join(ctx.rendererDir, 'entries/popover/index.html'),
    )
  }

  function hidePopover(): void {
    if (popoverView) {
      destroyViewInternal(popoverView)
      popoverView = null
      ctx.notify.popoverClosed()
    }
  }

  function repositionAll(): void {
    if (simulatorView && simulatorViewAdded)
      applySimulatorBounds(lastSimWidth)
    if (settingsView && settingsViewAdded)
      applySettingsBounds()
    if (popoverView)
      applyPopoverBounds()
  }

  function disposeAll(): void {
    detachSimulator()
  }

  function logChildViews(_label: string): void {
    // Debug helper — intentionally a no-op in production. Kept on the
    // ViewManager interface so call sites and tests stay stable.
  }

  function positionSimulator(simWidth: number): void {
    applySimulatorBounds(simWidth)
  }

  function positionSettings(): void {
    applySettingsBounds()
  }

  function resize(simWidth: number): void {
    lastSimWidth = simWidth
    if (simulatorViewAdded) applySimulatorBounds(simWidth)
    if (settingsViewAdded) applySettingsBounds()
  }

  function setVisible(visible: boolean, simWidth: number): void {
    lastSimWidth = simWidth
    if (!simulatorView) return

    if (visible && !simulatorViewAdded) {
      showSimulator(simWidth)
    } else if (!visible) {
      hideSimulator()
    }
  }

  return {
    attachSimulator,
    detachSimulator,
    showSimulator,
    hideSimulator,
    showSettings,
    hideSettings,
    showPopover,
    hidePopover,
    repositionAll,
    disposeAll,
    logChildViews,
    positionSimulator,
    positionSettings,
    getSimulatorWebContentsId: () => simulatorWebContentsId,
    getLastSimWidth: () => lastSimWidth,
    isSimulatorAdded: () => simulatorViewAdded,
    hasSimulatorView: () => simulatorView !== null,
    getSettingsWebContents: () => {
      if (!settingsView) return null
      if (settingsView.webContents.isDestroyed()) return null
      return settingsView.webContents
    },
    resize,
    setVisible,
  }
}
