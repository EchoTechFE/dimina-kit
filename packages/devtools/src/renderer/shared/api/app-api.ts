import { AppChannel } from '../../../shared/ipc-channels'
import type { HeaderActionInfo, HeaderAvatarInfo } from '../../../shared/types'
import { invoke, on } from './ipc-transport'

export interface AppBranding {
  appName?: string
}

/** Resolve branding metadata (app name, etc.) for the current host app. */
export function getBranding(): Promise<AppBranding | undefined> {
  return invoke<AppBranding | undefined>(AppChannel.GetBranding)
}

export type { HeaderActionInfo, HeaderAvatarInfo }

/** Resolve the optional host-provided avatar rendered in the project header. */
export function getHeaderAvatar(): Promise<HeaderAvatarInfo | null> {
  return invoke<HeaderAvatarInfo | null>(AppChannel.GetHeaderAvatar)
}

/** Invoke the optional host handler for the header avatar slot. */
export function invokeHeaderAvatar(): Promise<void> {
  return invoke<void>(AppChannel.InvokeHeaderAvatar)
}

/** Subscribe to host profile changes; callers should re-run getHeaderAvatar. */
export function onHeaderAvatarChanged(handler: () => void): () => void {
  return on<[]>(AppChannel.HeaderAvatarChanged, () => handler())
}

/** Resolve host-provided actions rendered in the project header. */
export function getHeaderActions(): Promise<HeaderActionInfo[]> {
  return invoke<HeaderActionInfo[]>(AppChannel.GetHeaderActions)
}

/** Invoke a host-provided project header action. */
export function invokeHeaderAction(id: string): Promise<void> {
  return invoke<void>(AppChannel.InvokeHeaderAction, id)
}

/** Subscribe to host action changes; callers should re-run getHeaderActions. */
export function onHeaderActionsChanged(handler: () => void): () => void {
  return on<[]>(AppChannel.HeaderActionsChanged, () => handler())
}
