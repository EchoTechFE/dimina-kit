import type { CompileConfig } from '@/shared/types'
import type { NativeDeviceInfo, ViewBounds } from '../../../shared/ipc-channels'
import {
  SimulatorChannel,
  PanelChannel,
  ToolbarChannel,
  PopoverChannel,
  WindowChannel,
  ViewChannel,
} from '../../../shared/ipc-channels'
import { invoke, invokeStrict, on } from './ipc-transport'

export interface PanelTab {
  id: string
  label: string
}

export interface PopoverInitPayload {
  top: number
  left: number
  config: CompileConfig
  pages: string[]
}

export interface ToolbarAction {
  id: string
  label: string
  kind?: 'button' | 'avatar'
  placement?: 'leading' | 'primary' | 'trailing'
  icon?: string
  displayInitial?: string
  avatarUrl?: string
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

/** Detach the Chromium DevTools view. */
export function detachSimulator(): Promise<void> {
  return invoke<void>(SimulatorChannel.Detach)
}

/** Notify the main process of a new simulator panel width. */
export function resizeSimulator(simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.Resize, simWidth)
}

/**
 * NATIVE-HOST ONLY. Report the device-bezel inner-screen rect (CSS px from the
 * main window content top-left, i.e. `getBoundingClientRect()` left/top) plus
 * the device zoom percent so the main process can overlay the simulator
 * WebContentsView precisely on the bezel and scale the nested render-host page.
 */
export function setNativeSimulatorBounds(p: {
  x: number
  y: number
  width: number
  height: number
  zoom: number
}): Promise<void> {
  return invoke<void>(SimulatorChannel.SetNativeBounds, p)
}

/** Show or hide the Chromium DevTools view. */
export function setSimulatorVisible(visible: boolean, simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.SetVisible, visible, simWidth)
}

/**
 * NATIVE-HOST ONLY. Push the selected device's logical metrics so main can
 * live-update the running service-host window's host-env snapshot — the
 * authoritative `wx.getSystemInfoSync()` source — without a relaunch. The
 * default `<webview>` path delivers device info to the guest via `device:change`.
 */
export function setNativeDeviceInfo(device: NativeDeviceInfo): Promise<void> {
  return invoke<void>(SimulatorChannel.SetDeviceInfo, device)
}

/** Enumerate the built-in panels (WXML / AppData / Storage) currently enabled. */
export function listPanels(): Promise<PanelTab[]> {
  return invokeStrict<PanelTab[]>(PanelChannel.List)
}

/** Request the main process to switch the right pane back to the DevTools view. */
export function selectSimulatorPanel(): Promise<void> {
  return invoke<void>(PanelChannel.SelectSimulator)
}

/** Read the host-app-configured toolbar actions rendered above the toolbar. */
export function getToolbarActions(): Promise<ToolbarAction[]> {
  return invokeStrict<ToolbarAction[]>(ToolbarChannel.GetActions)
}

/** Trigger a named toolbar action. */
export function invokeToolbarAction(actionId: string): Promise<void> {
  return invoke<void>(ToolbarChannel.Invoke, actionId)
}

/** Show the compile-popover overlay anchored below `top`/`left`. */
export function showPopover(payload: PopoverShowPayload): Promise<void> {
  return invoke<void>(PopoverChannel.Show, payload)
}

/** Hide the compile-popover overlay. */
export function hidePopover(): Promise<void> {
  return invoke<void>(PopoverChannel.Hide)
}

// ── Event subscriptions ─────────────────────────────────────────────────────

/** Listen for toolbar action list changes. */
export function onToolbarActionsChanged(handler: () => void): () => void {
  return on<[]>(ToolbarChannel.ActionsChanged, () => handler())
}

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
 * Publish the simulator Chromium-DevTools placeholder's measured rectangle.
 * `width: 0, height: 0` means the overlay is hidden (e.g. the Console tab is
 * not selected) — the main process removes it from the contentView.
 */
export function publishSimulatorDevtoolsBounds(bounds: ViewBounds): Promise<void> {
  return invoke<void>(ViewChannel.SimulatorDevtoolsBounds, bounds)
}

/**
 * Publish the host-controllable toolbar placeholder's measured rectangle so the
 * main process can overlay the toolbar WebContentsView precisely. `width: 0,
 * height: 0` means the placeholder is absent (the reserved height is 0) — the
 * main process removes the toolbar view from the contentView.
 */
export function publishHostToolbarBounds(bounds: ViewBounds): Promise<void> {
  return invoke<void>(ViewChannel.HostToolbarBounds, bounds)
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
