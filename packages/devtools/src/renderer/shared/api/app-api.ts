import { AppChannel } from '../../../shared/ipc-channels'
import { invoke } from './ipc-transport'

export interface AppBranding {
  appName?: string
}

/** Resolve branding metadata (app name, etc.) for the current host app. */
export function getBranding(): Promise<AppBranding | undefined> {
  return invoke<AppBranding | undefined>(AppChannel.GetBranding)
}
