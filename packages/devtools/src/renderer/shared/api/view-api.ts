import type { CompileConfig } from '@/shared/types'
import type { ViewBounds } from '../../../shared/ipc-channels'
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
}

export interface PopoverShowPayload {
  top: number
  left: number
  config: CompileConfig
  pages: string[]
}

/** Attach the Chromium DevTools view onto the given simulator WebContents. */
export function attachSimulator(simWebContentsId: number, simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.Attach, simWebContentsId, simWidth)
}

/** Detach the Chromium DevTools view. */
export function detachSimulator(): Promise<void> {
  return invoke<void>(SimulatorChannel.Detach)
}

/** Notify the main process of a new simulator panel width. */
export function resizeSimulator(simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.Resize, simWidth)
}

/** Show or hide the Chromium DevTools view. */
export function setSimulatorVisible(visible: boolean, simWidth: number): Promise<void> {
  return invoke<void>(SimulatorChannel.SetVisible, visible, simWidth)
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
 * Publish the simulator Chromium-DevTools placeholder's measured rectangle.
 * `width: 0, height: 0` means the overlay is hidden (e.g. the Console tab is
 * not selected) — the main process removes it from the contentView.
 */
export function publishSimulatorDevtoolsBounds(bounds: ViewBounds): Promise<void> {
  return invoke<void>(ViewChannel.SimulatorDevtoolsBounds, bounds)
}
