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

export interface WorkbenchSettingsValue {
  cdp: CdpSettings
  mcp: McpSettings
  theme: ThemeSource
}

export interface CdpStatus {
  configured: boolean
  port: number
  active: boolean
  activePort: number | null
  implicitDevDefault?: boolean
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

/** Read the current Chrome DevTools Protocol listener status. */
export function getCdpStatus(): Promise<CdpStatus> {
  return invokeStrict<CdpStatus>(WorkbenchSettingsChannel.GetCdpStatus)
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
