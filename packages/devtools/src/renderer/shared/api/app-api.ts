import { AppChannel } from '../../../shared/ipc-channels'
import { invoke, invokeStrict } from './ipc-transport'

export interface AppBranding {
  appName?: string
}

/** Resolve branding metadata (app name, etc.) for the current host app. */
export function getBranding(): Promise<AppBranding | undefined> {
  return invoke<AppBranding | undefined>(AppChannel.GetBranding)
}

/**
 * Resolve the absolute `file://` URL to the simulator preload script. The
 * simulator `<webview>` wires this in as its `preload` attribute.
 */
export function getPreloadPath(): Promise<string> {
  return invokeStrict<string>(AppChannel.GetPreloadPath)
}
