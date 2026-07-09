import type { CompileConfig } from '@/shared/types'
import { SettingsChannel, WorkbenchSettingsChannel } from '../../../shared/ipc-channels'
import { invoke, invokeStrict, on, send } from './ipc-transport'

export type ThemeSource = 'system' | 'dark' | 'light'

export interface CdpSettings {
  enabled: boolean
  port: number
}

export interface McpSettings {
  enabled: boolean
  port: number
}

export interface CompileSettings {
  /** Watch project files and auto-recompile on change. */
  autoBuild: boolean
}

export interface PreviewSettings {
  /** Reload the simulator once a watcher-triggered rebuild lands. */
  autoReload: boolean
}

export interface WorkbenchSettingsValue {
  cdp: CdpSettings
  mcp: McpSettings
  compile: CompileSettings
  preview: PreviewSettings
  theme: ThemeSource
  /** Required by the main-process save schema — kept on the renderer value so a
   * `saveWorkbenchSettings({ ...settings })` before `getWorkbenchSettings()`
   * backfills is not rejected for a missing field. Round-tripped untouched. */
  lastCreateBaseDir: string | null
}

export interface CdpStatus {
  configured: boolean
  port: number
  active: boolean
  activePort: number | null
  implicitDevDefault?: boolean
}

export interface McpStatus {
  configured: boolean
  configuredPort: number
  running: boolean
  activePort: number | null
  error: string | null
}

export interface ProjectSettingsPatch {
  uploadWithSourceMap?: boolean
}

export interface SettingsInitPayload {
  projectPath: string
  config: CompileConfig
  projectSettings?: {
    uploadWithSourceMap: boolean
  }
}

export interface WorkbenchSettingsInitPayload {
  settings: WorkbenchSettingsValue
}

// ── Embedded project settings overlay ───────────────────────────────────────

/**
 * Show (`true`) or hide (`false`) the embedded project-settings overlay.
 * Drives the main-process `settings:setVisible` handler — `true` shows the
 * overlay and triggers the `settings:init` payload push, `false` hides it.
 */
export function setSettingsVisible(visible: boolean): Promise<void> {
  return invoke<void>(SettingsChannel.SetVisible, visible)
}

/** Broadcast a compile-config change from the embedded settings overlay. */
export function emitSettingsConfigChanged(config: CompileConfig): void {
  send(SettingsChannel.ConfigChanged, config)
}

/** Broadcast a project-settings patch from the embedded settings overlay. */
export function emitProjectSettingsChanged(patch: ProjectSettingsPatch): void {
  send(SettingsChannel.ProjectSettingsChanged, patch)
}

/** Subscribe to the `settings:init` payload sent into the overlay on open. */
export function onSettingsInit(
  handler: (payload: SettingsInitPayload) => void,
): () => void {
  return on<[SettingsInitPayload]>(SettingsChannel.Init, (payload) => handler(payload))
}

// ── Standalone workbench-settings window ─────────────────────────────────────

/** Read the current devtools (global) settings. */
export function getWorkbenchSettings(): Promise<WorkbenchSettingsValue> {
  return invokeStrict<WorkbenchSettingsValue>(WorkbenchSettingsChannel.Get)
}

/** Persist the workbench (global) settings. */
export function saveWorkbenchSettings(
  settings: WorkbenchSettingsValue,
): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>(WorkbenchSettingsChannel.Save, settings)
}

/** Apply a theme override without persisting it. */
export function setWorkbenchTheme(theme: ThemeSource): Promise<void> {
  return invoke<void>(WorkbenchSettingsChannel.SetTheme, theme)
}

/**
 * Subscribe to active-color-scheme flips (OS change or in-app SetTheme). The
 * app's CSS reacts to `prefers-color-scheme` on its own; this is for JS
 * consumers (Monaco's theme) that can't observe that media change because
 * Electron doesn't dispatch the renderer's matchMedia change event for
 * programmatic `nativeTheme.themeSource` assignments. Returns an unsubscribe.
 */
export function onThemeChanged(handler: (isDark: boolean) => void): () => void {
  return on<[boolean]>(WorkbenchSettingsChannel.ThemeChanged, (isDark) => handler(isDark))
}

/** Read the current Chrome DevTools Protocol listener status. */
export function getCdpStatus(): Promise<CdpStatus> {
  return invokeStrict<CdpStatus>(WorkbenchSettingsChannel.GetCdpStatus)
}

/** Read the current MCP server runtime status. */
export function getMcpStatus(): Promise<McpStatus> {
  return invokeStrict<McpStatus>(WorkbenchSettingsChannel.GetMcpStatus)
}

/** Subscribe to init broadcasts for the workbench-settings window. */
export function onWorkbenchSettingsInit(
  handler: (payload: WorkbenchSettingsInitPayload) => void,
): () => void {
  return on<[WorkbenchSettingsInitPayload]>(
    WorkbenchSettingsChannel.Init,
    (payload) => handler(payload),
  )
}
