import { nativeTheme } from 'electron'

/**
 * Background color that matches the current system color scheme.
 * Pass as `backgroundColor` when creating BrowserWindows to prevent
 * a white or black flash before the renderer CSS loads.
 *
 * Dark:  hsl(0 0% 10%) ≈ #1a1a1a  (--color-bg)
 * Light: hsl(0 0% 98%) ≈ #fafafa  (--color-bg)
 */
export function themeBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa'
}
