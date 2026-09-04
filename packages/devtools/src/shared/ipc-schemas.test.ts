/**
 * SimulatorSetDeviceInfoSchema against the @devicekit/devices-driven
 * NativeDeviceInfo contract: `notchType` is gone, `device` is an optional
 * lookup key into the devices table, `orientation`/`platform` are closed
 * enums.
 */
import { describe, it, expect } from 'vitest'
import { DEVICE_NAMES } from '@devicekit/devices'
import { SimulatorSetDeviceInfoSchema } from './ipc-schemas'

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    device: DEVICE_NAMES.HUAWEI_Mate_60_Pro,
    brand: 'HUAWEI',
    model: 'Mate 60 Pro',
    system: 'HarmonyOS 4.0',
    platform: 'harmony',
    orientation: 'portrait',
    pixelRatio: 3,
    screenWidth: 393,
    screenHeight: 852,
    statusBarHeight: 36,
    safeAreaInsets: { top: 36, right: 0, bottom: 0, left: 0 },
    ...overrides,
  }
}

describe('SimulatorSetDeviceInfoSchema', () => {
  it('accepts a device/orientation/harmony payload with no notchType', () => {
    const result = SimulatorSetDeviceInfoSchema.safeParse([basePayload()])
    expect(result.success).toBe(true)
  })

  it('accepts a payload with `device` omitted (custom/legacy metrics)', () => {
    const payload = basePayload()
    delete (payload as { device?: string }).device
    const result = SimulatorSetDeviceInfoSchema.safeParse([payload])
    expect(result.success).toBe(true)
  })

  it('rejects an orientation outside portrait/landscape', () => {
    const result = SimulatorSetDeviceInfoSchema.safeParse([basePayload({ orientation: 'upside' })])
    expect(result.success).toBe(false)
  })

  it('rejects a platform outside ios/android/harmony', () => {
    const result = SimulatorSetDeviceInfoSchema.safeParse([basePayload({ platform: 'web' })])
    expect(result.success).toBe(false)
  })
})
