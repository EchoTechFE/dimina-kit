import { useEffect, useState } from 'react'
import { DEVICES, DEFAULT_DEVICE, findDevice } from '@devicekit/devices'
import {
  notifyOverlayReady,
  onDevicePickerInit,
  selectDevice,
  cancelDevicePicker,
} from '@/shared/api'
import { DevicePicker } from '@/modules/main/features/project-runtime/components/device-picker'

/**
 * Thin stateful shell for the top-tier native device-picker overlay surface.
 * `DevicePicker` stays a pure props/callback component; this mounts it against
 * the device main pushes after `showDevicePicker`, and relays the choice back
 * to the toolbar that owns the device state.
 *
 * Dropping `deviceName` back to null on select/dismiss unmounts the picker, so
 * the NEXT open mounts a fresh one: this view is reused across openings and a
 * previous session's search text, chip filters and highlighted row must not be
 * what the user sees next time.
 */
export default function DevicePickerPanel() {
  const [deviceName, setDeviceName] = useState<string | null>(null)

  useEffect(() => {
    const off = onDevicePickerInit((payload) => setDeviceName(payload.deviceName))
    notifyOverlayReady()
    return off
  }, [])

  if (deviceName === null) return null

  function handleSelect(name: string) {
    setDeviceName(null)
    selectDevice({ deviceName: name })
  }

  function handleClose() {
    setDeviceName(null)
    cancelDevicePicker()
  }

  return (
    <DevicePicker
      device={findDevice(deviceName) ?? DEFAULT_DEVICE}
      devices={DEVICES}
      onSelect={handleSelect}
      onClose={handleClose}
    />
  )
}
