import type { SimulatorMiniApp } from '../simulator-mini-app'
import type { NavBarPlatform } from '@dimina-kit/electron-runtime/simulator-ui'

export interface DeviceShellProps {
  miniApp: SimulatorMiniApp
  bridgeId: string
  width?: number
  height?: number
  /** Only the visible shell owns the downstream extension layer. */
  active?: boolean
  /** Which platform's NavigationBar conventions to emulate. */
  platform?: NavBarPlatform
}
