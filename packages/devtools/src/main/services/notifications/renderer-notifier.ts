import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import type { CompileConfig, LaunchConfig } from '../../../shared/types.js'
import {
  ProjectChannel,
  SessionChannel,
  WindowChannel,
  SettingsChannel,
  PopoverChannel,
  WorkbenchSettingsChannel,
  EditorChannel,
  ViewChannel,
  type EditorOpenFilePayload,
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
  /** Freshly-read page list, carried on a hot-reload status so the launch dropdown stays current. Absent when the read failed or wasn't attempted. */
  pages?: string[]
  /** Present (`'dead'`) once the project's file watcher has stopped — saves no longer trigger an automatic rebuild. */
  watcher?: 'dead'
}

/**
 * Payload for the `session:runtimeStatus` push — the post-compile SESSION
 * lifecycle main tracks per `appSessionId` in bridge-router (`AppSession`
 * itself is main-private; this is the public projection). A successful
 * compile only means the resource tree exists; it says nothing about whether
 * the simulator actually booted — this closes that gap.
 */
export interface SessionRuntimeStatusPayload {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  /**
   * Machine-readable cause, present on `'launch-failed'` and `'crashed'`:
   * `'timeout'` — the launch watchdog (`LAUNCH_TIMEOUT_MS`) expired before the
   * root page reported `domReady`; `'logic-bundle-unreachable'` — the
   * compiled `logic.js` could not be fetched/executed;
   * `'service-host-navigation-failed'` — the service-host window failed to
   * navigate to its spawn URL; `'service-host-crashed'` — the service host's
   * renderer process was gone. Plain `string` (not a literal union) so an
   * unrecognized future code degrades gracefully instead of a type error.
   */
  code?: string
  /** Human-readable detail, mirroring the short form of the matching `ctx.diagnostics` report. */
  reason?: string
  /**
   * Present on `'launching'` when `handleSpawn`'s page-mount gate
   * (`resolveRootPagePath`) substituted the resolved page for the request —
   * i.e. `SpawnResult.pageFallbackApplied` was true for this spawn.
   */
  pageFallback?: { requested: string; resolved: string }
}

/**
 * Payload for the `project:compileLog` push — one filtered dmcc log line.
 * `at` is stamped in the main process when the line is captured.
 */
export interface CompileLogPayload {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
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
 * main process. Instead of calling `someWebContents.send(channel, payload)`
 * directly, every site goes through a typed method here so that channel names,
 * payload shapes and `isDestroyed()` guards live in exactly one place.
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
  /** Broadcast a session's post-compile runtime lifecycle to the main renderer. */
  sessionRuntimeStatus(payload: SessionRuntimeStatusPayload): void
  /** Push one per-line dmcc compile-log entry to the main renderer. */
  compileLog(payload: CompileLogPayload): void
  /** Ask the main renderer to navigate back to its landing screen. */
  windowNavigateBack(): void
  /** Tell the main renderer the compile popover has been closed. */
  popoverClosed(): void
  /** Ask the main renderer to relaunch the simulator with a new config. */
  popoverRelaunch(config: CompileConfig): void
  /** Ask the main renderer to switch to a launch config (or null for normal). */
  popoverSwitchLaunchConfig(id: string | null): void
  /** Ask the main renderer to update its launch configs list. */
  popoverUpdateLaunchConfigs(configs: LaunchConfig[]): void
  /**
   * Push the reserved host-toolbar height to the main renderer so its toolbar
   * placeholder div resizes (closes the host-toolbar dynamic-height loop).
   */
  hostToolbarHeightChanged(height: number): void
  /**
   * Ask the main renderer's Monaco editor to open a project file at a position.
   * Drives the "click a console file link → open in editor" pipeline.
   */
  editorOpenFile(payload: EditorOpenFilePayload): void

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
  windows: { readonly mainWindow: BrowserWindow }
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
    if (ctx.windows.mainWindow.isDestroyed()) return
    const wc = liveWebContents(ctx.windows.mainWindow.webContents)
    if (!wc) return
    wc.send(channel, ...args)
  }

  return {
    projectStatus(payload) {
      sendToMain(ProjectChannel.Status, payload)
    },
    sessionRuntimeStatus(payload) {
      sendToMain(SessionChannel.RuntimeStatus, payload)
    },
    compileLog(payload) {
      sendToMain(ProjectChannel.CompileLog, payload)
    },
    windowNavigateBack() {
      sendToMain(WindowChannel.NavigateBack)
    },
    popoverClosed() {
      sendToMain(PopoverChannel.Closed)
    },
    popoverRelaunch(config) {
      sendToMain(PopoverChannel.Relaunch, config)
    },
    popoverSwitchLaunchConfig(id) {
      sendToMain(PopoverChannel.SwitchLaunchConfig, id)
    },
    popoverUpdateLaunchConfigs(configs) {
      sendToMain(PopoverChannel.UpdateLaunchConfigs, configs)
    },
    hostToolbarHeightChanged(height) {
      sendToMain(ViewChannel.HostToolbarHeightChanged, height)
    },
    editorOpenFile(payload) {
      sendToMain(EditorChannel.OpenFile, payload)
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
