import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import type { CompileConfig } from '../../../shared/types.js'
import {
  ProjectChannel,
  WindowChannel,
  SettingsChannel,
  PopoverChannel,
  WorkbenchChannel,
  ToolbarChannel,
  WorkbenchSettingsChannel,
} from '../../../shared/ipc-channels.js'
import type { WorkbenchSettings } from '../settings/index.js'
import type { ProjectSettings } from '../projects/project-repository.js'

/**
 * Payload for the `project:status` event sent whenever compile status changes.
 */
export interface ProjectStatusPayload {
  status: string
  message: string
  /** True when the status update is emitted by the file-watcher rebuild loop. */
  hotReload?: boolean
}

/**
 * Payload for the `settings:init` event sent into the embedded settings overlay
 * right after it is shown.
 */
export interface SettingsInitPayload {
  projectPath: string
  config: CompileConfig
  projectSettings: ProjectSettings
}

/**
 * Payload for the `devtoolsSettings:init` event sent into the standalone
 * workbench-settings window right after it becomes visible.
 */
export interface WorkbenchSettingsInitPayload {
  settings: WorkbenchSettings
}

/**
 * Unified entry point for every main → renderer event sent by the devtools
 * main process. Every site that previously called
 * `someWebContents.send(channel, payload)` now goes through a typed method
 * here so that channel names, payload shapes and `isDestroyed()` guards live
 * in exactly one place.
 *
 * Methods resolve their target `WebContents` lazily from references provided
 * at call time (or read from the owning context) and silently no-op when the
 * target is missing or already destroyed — the previous behaviour of every
 * scattered send site.
 */
export interface RendererNotifier {
  // ── Main window ──────────────────────────────────────────────────────────
  /** Broadcast project compile status transitions to the main renderer. */
  projectStatus(payload: ProjectStatusPayload): void
  /** Ask the main renderer to navigate back to its landing screen. */
  windowNavigateBack(): void
  /** Tell the main renderer the embedded settings overlay has been closed. */
  settingsClosed(): void
  /** Broadcast an updated compile config to the main renderer. */
  settingsChanged(config: CompileConfig): void
  /** Tell the main renderer the compile popover has been closed. */
  popoverClosed(): void
  /** Ask the main renderer to relaunch the simulator with a new config. */
  popoverRelaunch(config: CompileConfig): void
  /** Ask the main renderer to re-initialise the devtools panels. */
  workbenchReset(): void
  /** Tell the main renderer the toolbar actions list has changed. */
  toolbarActionsChanged(): void

  // ── Embedded overlays ────────────────────────────────────────────────────
  /** Initialise the currently shown compile popover overlay. */
  popoverInit(popoverView: WebContentsView, payload: unknown): void
  /** Initialise the currently shown settings overlay (no-op if hidden). */
  settingsInit(payload: SettingsInitPayload): void

  // ── Standalone windows ───────────────────────────────────────────────────
  /** Initialise the standalone workbench-settings window. */
  workbenchSettingsInit(
    window: BrowserWindow,
    payload: WorkbenchSettingsInitPayload,
  ): void
}

/**
 * Context surface used by the notifier. We only need a small slice of the
 * full WorkbenchContext here; typing it this way avoids an import cycle
 * between the notifier module and workbench-context.
 */
export interface NotifierContext {
  mainWindow: BrowserWindow
  views: { getSettingsWebContents(): WebContents | null }
}

/** Safely resolve a WebContents, skipping destroyed / missing targets. */
function liveWebContents(wc: WebContents | undefined | null): WebContents | null {
  if (!wc) return null
  if (wc.isDestroyed()) return null
  return wc
}

/**
 * Build a RendererNotifier bound to the given context. This is the only
 * module allowed to call `webContents.send(...)` in the devtools main process.
 */
export function createRendererNotifier(ctx: NotifierContext): RendererNotifier {
  function sendToMain(channel: string, ...args: unknown[]): void {
    if (ctx.mainWindow.isDestroyed()) return
    const wc = liveWebContents(ctx.mainWindow.webContents)
    if (!wc) return
    wc.send(channel, ...args)
  }

  return {
    projectStatus(payload) {
      sendToMain(ProjectChannel.Status, payload)
    },
    windowNavigateBack() {
      sendToMain(WindowChannel.NavigateBack)
    },
    settingsClosed() {
      sendToMain(SettingsChannel.Closed)
    },
    settingsChanged(config) {
      sendToMain(SettingsChannel.Changed, config)
    },
    popoverClosed() {
      sendToMain(PopoverChannel.Closed)
    },
    popoverRelaunch(config) {
      sendToMain(PopoverChannel.Relaunch, config)
    },
    workbenchReset() {
      sendToMain(WorkbenchChannel.Reset)
    },
    toolbarActionsChanged() {
      sendToMain(ToolbarChannel.ActionsChanged)
    },

    popoverInit(popoverView, payload) {
      const wc = liveWebContents(popoverView.webContents)
      if (!wc) return
      wc.send(PopoverChannel.Init, payload)
    },
    settingsInit(payload) {
      const wc = liveWebContents(ctx.views.getSettingsWebContents())
      if (!wc) return
      wc.send(SettingsChannel.Init, payload)
    },

    workbenchSettingsInit(window, payload) {
      if (window.isDestroyed()) return
      const wc = liveWebContents(window.webContents)
      if (!wc) return
      wc.send(WorkbenchSettingsChannel.Init, payload)
    },
  }
}
