import type { SimulatorMiniApp } from '../simulator-mini-app'

export interface DeviceShellProps {
  miniApp: SimulatorMiniApp
  bridgeId: string
  width?: number
  height?: number
  /** Only the visible shell owns the downstream extension layer. */
  active?: boolean
}
