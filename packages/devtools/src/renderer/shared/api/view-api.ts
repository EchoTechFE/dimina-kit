import type { CompileConfig } from '@/shared/types'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels'
import {
  SimulatorChannel,
  WindowChannel,
} from '../../../shared/ipc-channels'
import {
  PopoverChannel,
  OverlayChannel,
  TooltipChannel,
  ProjectCreateChannel,
  ViewChannel,
} from '../../../shared/ipc-channels-overlays'
import type { PlacementSnapshot } from '@dimina-kit/electron-deck/layout'
import { invoke, on, send } from './ipc-transport'
import type { ProjectTemplateInfo } from './project-api'

export interface PopoverInitPayload {
  top: number
  left: number
  config: CompileConfig
  pages: string[]
}

export interface PopoverShowPayload {
  top: number
  left: number
  config: CompileConfig
  pages: string[]
}

/**
 * Ask main to create the simulator as a top-level WebContentsView loading
 * `simulatorUrl` (so DeviceShell's nested render-host `<webview>`s can attach —
 * impossible inside a renderer `<webview>` guest). native-host is the sole
 * runtime, so this is the only simulator-mount entry point.
 */
export function attachNativeSimulator(simulatorUrl: string, simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.AttachNative, simulatorUrl, simWidth)
}

/**
 * Soft-reload the live native simulator after a watcher rebuild: main forwards
 * a RELAUNCH into the existing DeviceShell WCV (which boots a new app session
 * and swaps when it is ready) instead of destroying the view. Resolves `true`
 * when main accepted; `false`/`undefined` (no live+ready shell, or the lenient
 * invoke swallowed a failure) means the caller must fall back to the hard
 * {@link attachNativeSimulator} rebuild.
 */
export function softReloadNativeSimulator(simulatorUrl: string): Promise<boolean | undefined> {
  return invoke<boolean | undefined>(SimulatorChannel.SoftReload, simulatorUrl)
}

/** Detach the Chromium DevTools view. */
export function detachSimulator(): Promise<void> {
  return invoke<void>(SimulatorChannel.Detach)
}

/**
 * NATIVE-HOST ONLY. Push the selected device's logical metrics so main can
 * live-update the running service-host window's host-env snapshot — the
 * authoritative `wx.getSystemInfoSync()` source — without a relaunch.
 */
export function setNativeDeviceInfo(device: NativeDeviceInfo): Promise<void> {
  return invoke<void>(SimulatorChannel.SetDeviceInfo, device)
}

/** Show the compile-popover overlay anchored below `top`/`left`. */
export function showPopover(payload: PopoverShowPayload): Promise<void> {
  return invoke<void>(PopoverChannel.Show, payload)
}

/** Hide the compile-popover overlay. */
export function hidePopover(): Promise<void> {
  return invoke<void>(PopoverChannel.Hide)
}

export interface TooltipShowPayload {
  anchor: { x: number; y: number; width: number; height: number }
  text: string
}

export interface TooltipRenderPayload {
  requestId: number
  text: string
  maxWidth: number
}

/** Warm the hidden tooltip renderer for the project toolbar. */
export function prepareTooltip(): void {
  send(TooltipChannel.Prepare)
}

/**
 * Show (or reposition + retext, if already shown) the tooltip overlay
 * anchored to `anchor`. Fire-and-forget (`send`, not `invoke`) — a tooltip
 * needs to feel instant on hover, and nothing here needs a reply. See
 * `TooltipChannel`'s doc-comment (shared/ipc-channels.ts) for why this is a
 * WebContentsView overlay rather than the `ui/tooltip` Radix component or the
 * native `title` attribute.
 */
export function showTooltip(payload: TooltipShowPayload): void {
  send(TooltipChannel.Show, payload)
}

/** Hide the tooltip overlay. */
export function hideTooltip(): void {
  send(TooltipChannel.Hide)
}

/** Announce that an overlay renderer has installed all inbound listeners. */
export function notifyOverlayReady(): void {
  send(OverlayChannel.Ready)
}

/** Subscribe to the latest render request for the tooltip overlay. */
export function onTooltipInit(handler: (payload: TooltipRenderPayload) => void): () => void {
  return on<[TooltipRenderPayload]>(TooltipChannel.Init, (payload) => handler(payload))
}

/** Report the tooltip's intrinsic painted footprint for the current request. */
export function reportTooltipMeasured(payload: {
  requestId: number
  width: number
  height: number
}): void {
  send(TooltipChannel.Measured, payload)
}

export interface ProjectCreateShowPayload {
  templates: ProjectTemplateInfo[]
  defaultBaseDir: string
}

export interface ProjectCreateSubmitPayload {
  name: string
  path: string
  templateId: string
}

/**
 * Ask main to show the project-create overlay panel (VIEW_LAYER.dialog), fed
 * the already-resolved template catalog + suggested base dir. Replaces the
 * old `fixed inset-0` Radix portal, which paints inside the main window's own
 * renderer and is occluded by any native WebContentsView mounted on top.
 */
export function showProjectCreateDialog(payload: ProjectCreateShowPayload): void {
  send(ProjectCreateChannel.Show, payload)
}

/** Hide the project-create overlay panel without submitting. */
export function cancelProjectCreate(): void {
  send(ProjectCreateChannel.Cancel)
}

/** Submit the collected create-project form from the overlay panel. */
export function submitProjectCreate(input: ProjectCreateSubmitPayload): void {
  send(ProjectCreateChannel.Submit, input)
}

/** Subscribe to the render request pushed into the project-create overlay panel. */
export function onProjectCreateInit(
  handler: (payload: ProjectCreateShowPayload) => void,
): () => void {
  return on<[ProjectCreateShowPayload]>(ProjectCreateChannel.Init, (payload) => handler(payload))
}

/** Subscribe to the relayed create-project submission (received by main.tsx, not the panel itself). */
export function onProjectCreateSubmitted(
  handler: (input: ProjectCreateSubmitPayload) => void,
): () => void {
  return on<[ProjectCreateSubmitPayload]>(ProjectCreateChannel.Submitted, (input) => handler(input))
}

// ── Event subscriptions ─────────────────────────────────────────────────────

/** Listen for popover-closed broadcasts emitted by the main process. */
export function onPopoverClosed(handler: () => void): () => void {
  return on<[]>(PopoverChannel.Closed, () => handler())
}

/**
 * Subscribe to the `popover:init` event received by the popover window itself
 * after the main process positions it and feeds it the current compile config.
 */
export function onPopoverInit(
  handler: (payload: PopoverInitPayload) => void,
): () => void {
  return on<[PopoverInitPayload]>(PopoverChannel.Init, (payload) => handler(payload))
}

/** Listen for popover-relaunch broadcasts emitted by the main process. */
export function onPopoverRelaunch(
  handler: (config: CompileConfig) => void,
): () => void {
  return on<[CompileConfig]>(PopoverChannel.Relaunch, (config) => handler(config))
}

/** Listen for the back-to-project-list navigation event from the app menu. */
export function onWindowNavigateBack(handler: () => void): () => void {
  return on<[]>(WindowChannel.NavigateBack, () => handler())
}

/**
 * Listen for the open-project push from the main process (MCP `project_open`).
 * The renderer owns the open path — mounting ProjectRuntime is what compiles
 * the project and attaches the simulator — so main asks instead of opening
 * the workspace session itself.
 */
export function onWindowOpenProject(
  handler: (project: { name: string; path: string }) => void,
): () => void {
  return on<[{ name: string; path: string }]>(
    WindowChannel.OpenProject,
    (project) => handler(project),
  )
}

/**
 * Report the current top-level screen to main so its window-close decision
 * knows whether to return to the project list or quit the app. Call on every
 * screen change, including entering a project (BEFORE the open resolves — a
 * failed open then leaves main's mirror = 'project', so closing returns to the
 * list instead of quitting). Fire-and-forget.
 */
export function notifyWindowScreen(screen: 'list' | 'project'): void {
  void invoke<void>(WindowChannel.ScreenState, screen)
}

/**
 * NATIVE-HOST ONLY. Subscribe to the visible page route pushed by main on every
 * in-app navigation (the page stack lives in the DeviceShell WebContentsView,
 * so the renderer can't observe it from `<webview>` nav events). The default
 * path derives the current page from the simulator `<webview>` itself and never
 * receives this.
 */
export function onSimulatorCurrentPage(handler: (pagePath: string) => void): () => void {
  return on<[string]>(SimulatorChannel.CurrentPage, (pagePath) => handler(pagePath))
}

/**
 * Publish the window-level placement snapshot: the full desired-placement table
 * for every managed native view in this commit tick (one monotonic epoch,
 * `generation` per renderer lifetime). The renderer's central placement
 * publisher coalesces per-frame; main reconciles this against its actual view
 * tree. Single source of truth superseding the per-view bounds publishers.
 */
export function publishPlacementSnapshot(
  snapshot: PlacementSnapshot<{ zoom?: number }>,
): Promise<void> {
  return invoke<void>(ViewChannel.PlacementSnapshot, snapshot)
}

/**
 * Subscribe to the reserved host-toolbar height pushed by the main process after
 * the toolbar WCV's own renderer advertises its intrinsic content height. The
 * main-window renderer sets its placeholder div's CSS height to this, which
 * re-measures the forward anchor and closes the dynamic-height loop.
 */
export function onHostToolbarHeightChanged(handler: (height: number) => void): () => void {
  return on<[number]>(ViewChannel.HostToolbarHeightChanged, (height) => handler(height))
}

/**
 * Pull the last host-toolbar height main notified (retained main-side). Replay
 * companion to {@link onHostToolbarHeightChanged}: the push subscription mounts
 * with the project view, and the toolbar's size-advertiser deduplicates (a
 * height already reported is never re-sent), so a height pushed while no
 * project view was mounted is never re-pushed — a freshly-mounted placeholder
 * must pull it (cold start on the project list; always close-project →
 * reopen). Resolves `undefined` when the lenient invoke swallowed a main-side
 * failure; callers keep their current height in that case.
 */
export function getHostToolbarHeight(): Promise<number | undefined> {
  return invoke<number | undefined>(ViewChannel.HostToolbarGetHeight)
}

/**
 * Subscribe to the reserved host-sidebar width pushed by the main process after
 * the sidebar WCV's own renderer advertises its intrinsic content width. Mirrors
 * {@link onHostToolbarHeightChanged} on the inline axis.
 */
export function onHostSidebarWidthChanged(handler: (width: number) => void): () => void {
  return on<[number]>(ViewChannel.HostSidebarWidthChanged, (width) => handler(width))
}

/**
 * Pull the last host-sidebar width main notified (retained main-side). Replay
 * companion to {@link onHostSidebarWidthChanged} — mirrors {@link getHostToolbarHeight}
 * on the inline axis; see that function's doc-comment for the mount-time-replay
 * race it guards against.
 */
export function getHostSidebarWidth(): Promise<number | undefined> {
  return invoke<number | undefined>(ViewChannel.HostSidebarGetWidth)
}
