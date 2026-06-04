import type { NotchType } from '../../shared/ipc-channels'
import type { NavigationBarTextStyle } from './navigation-bar'
import './status-bar.css'

export interface StatusBarProps {
  /** Top safe-area inset = status bar height (device.safeAreaInsets.top). */
  height: number
  /** Bezel cutout family for the selected device. */
  notchType: NotchType
  /** Foreground (time / icons) color — follows the active page nav text style. */
  textStyle: NavigationBarTextStyle
}

interface NotchGeometry {
  width: number
  height: number
  /** Distance from the device top edge (0 = flush, like the X–13 notch). */
  top: number
  /** true = round only the bottom corners (the notch hangs off the top edge). */
  bottomOnly: boolean
}

/**
 * Visual geometry for the bezel cutout, in CSS px at the device's logical width.
 * The notch hangs flush off the top edge; the Dynamic Island floats below it.
 */
function notchGeometry(notchType: NotchType): NotchGeometry | null {
  switch (notchType) {
    case 'notch':
      return { width: 164, height: 30, top: 0, bottomOnly: true }
    case 'dynamic-island':
      return { width: 124, height: 36, top: 11, bottomOnly: false }
    case 'none':
    default:
      return null
  }
}

/**
 * iOS status bar overlay: time (9:41, the canonical Apple time) on the left,
 * signal / wifi / battery glyphs on the right, and the notch / Dynamic Island
 * cutout centered. Rendered as an absolute overlay pinned to the device top so
 * it sits above both the page webview and the nav-bar regardless of nav style.
 */
export function StatusBar({ height, notchType, textStyle }: StatusBarProps) {
  const notch = notchGeometry(notchType)
  const color = textStyle === 'black' ? '#000000' : '#ffffff'
  return (
    <div className="device-statusbar" style={{ height, color }} aria-hidden="true">
      <span className="device-statusbar__time">9:41</span>
      {notch && (
        <div
          className="device-statusbar__notch"
          style={{
            width: notch.width,
            height: notch.height,
            top: notch.top,
            borderRadius: notch.bottomOnly
              ? `0 0 ${Math.round(notch.height * 0.6)}px ${Math.round(notch.height * 0.6)}px`
              : `${notch.height / 2}px`,
          }}
        />
      )}
      <div className="device-statusbar__icons">
        <span className="device-statusbar__signal" />
        <span className="device-statusbar__wifi" />
        <span className="device-statusbar__battery" />
      </div>
    </div>
  )
}
