/**
 * DevicePicker: the searchable device selector that replaces the toolbar
 * native <select>. Must expose the full @devicekit/devices table (171
 * devices), not just CLASSIC_DEVICES, behind a trigger button + cmdk
 * search/filter panel — see DESIGN.md's device-picker plan.
 *
 * Contract this suite locks in beyond DESIGN.md's prose: each option row
 * carries `aria-label` equal to the device's bare `name` (so rows with a
 * shared name prefix, e.g. "iPhone 14" vs "iPhone 14 Pro", stay
 * unambiguous to query) and `data-current="true"` when it is the active
 * device.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import {
  DEVICES,
  DEFAULT_DEVICE,
  DEVICE_NAMES,
  findDevice,
  type DeviceProfile,
} from '@devicekit/devices'
import { DevicePicker, buildSearchValue } from './device-picker'

// cmdk measures its list via ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPicker(
  overrides: Partial<{
    device: DeviceProfile
    devices: readonly DeviceProfile[]
    onSelect: (name: string) => void
  }> = {},
) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const device = overrides.device ?? DEFAULT_DEVICE
  const devices = overrides.devices ?? DEVICES
  render(<DevicePicker device={device} devices={devices} onSelect={onSelect} />)
  return { onSelect, device, devices }
}

function openPicker(device: DeviceProfile = DEFAULT_DEVICE) {
  fireEvent.click(screen.getByRole('button', { name: device.name }))
}

describe('DevicePicker: full device table', () => {
  it('renders all 171 devices from @devicekit/devices as options once opened', async () => {
    renderPicker()
    openPicker()

    expect(await screen.findAllByRole('option')).toHaveLength(DEVICES.length)
  })
})

describe('DevicePicker: search', () => {
  it('narrows to Galaxy Tab S9 when searching "tab s9"', async () => {
    renderPicker()
    openPicker()

    const input = await screen.findByPlaceholderText('搜索机型：名称 / 系统 / 尺寸')
    fireEvent.change(input, { target: { value: 'tab s9' } })

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveAccessibleName(DEVICE_NAMES.Galaxy_Tab_S9)
  })

  it('matches the size typed with the × the row displays, not only ASCII x', async () => {
    renderPicker()
    openPicker()

    const input = await screen.findByPlaceholderText('搜索机型：名称 / 系统 / 尺寸')
    fireEvent.change(input, { target: { value: '393×852' } })

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-label'))).toContain(DEVICE_NAMES.iPhone_14_Pro)
  })
})

describe('DevicePicker: 平板 form-factor chip', () => {
  it('shows only formFactor=tablet devices once toggled on', async () => {
    renderPicker()
    openPicker()
    await screen.findAllByRole('option')

    fireEvent.click(screen.getByRole('button', { name: '平板' }))

    const expectedCount = DEVICES.filter((d) => d.formFactor === 'tablet').length
    expect(await screen.findAllByRole('option')).toHaveLength(expectedCount)
    expect(screen.getByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })).toBeInTheDocument()
  })
})

describe('DevicePicker: iOS os chip', () => {
  it('shows only os=ios devices once toggled on', async () => {
    renderPicker()
    openPicker()
    await screen.findAllByRole('option')

    fireEvent.click(screen.getByRole('button', { name: 'iOS' }))

    const expectedCount = DEVICES.filter((d) => d.os === 'ios').length
    expect(await screen.findAllByRole('option')).toHaveLength(expectedCount)
    expect(screen.queryByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })).not.toBeInTheDocument()
  })
})

describe('DevicePicker: selecting a device', () => {
  it('calls onSelect with the device name and closes the panel', async () => {
    const onSelect = vi.fn()
    renderPicker({ onSelect })
    openPicker()

    const row = await screen.findByRole('option', { name: DEVICE_NAMES.iPhone_14_Pro })
    fireEvent.click(row)

    expect(onSelect).toHaveBeenCalledWith(DEVICE_NAMES.iPhone_14_Pro)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('DevicePicker: current-device marker', () => {
  it('marks only the row for the currently active device', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    renderPicker({ device: current })
    openPicker(current)

    const currentRow = await screen.findByRole('option', { name: current.name })
    expect(currentRow).toHaveAttribute('data-current', 'true')

    const otherRow = screen.getByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })
    expect(otherRow).not.toHaveAttribute('data-current', 'true')
  })

  it('pre-highlights the current device on open so Enter keeps it instead of the first row', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    renderPicker({ device: current })
    openPicker(current)

    const currentRow = await screen.findByRole('option', { name: current.name })
    expect(currentRow).toHaveAttribute('aria-selected', 'true')
    const firstRow = screen.getByRole('option', { name: DEVICE_NAMES.iPhone_SE })
    expect(firstRow).not.toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on a fresh open re-selects the current device and closes', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    const { onSelect } = renderPicker({ device: current })
    openPicker(current)

    const input = await screen.findByRole('combobox')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(current.name)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('DevicePicker: dialog accessibility and dismissal', () => {
  it('names the dialog for assistive tech', async () => {
    renderPicker()
    openPicker()
    expect(await screen.findByRole('dialog', { name: '选择机型' })).toBeInTheDocument()
  })

  it('Escape closes without selecting and returns focus to the trigger button', async () => {
    const { onSelect, device } = renderPicker()
    openPicker(device)
    const dialog = await screen.findByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: device.name }))
  })
})

describe('buildSearchValue', () => {
  it('concatenates name, system, and the WxH screen size', () => {
    const iphone14Pro = findDevice(DEVICE_NAMES.iPhone_14_Pro)!

    const value = buildSearchValue(iphone14Pro)

    expect(value).toContain(iphone14Pro.name)
    expect(value).toContain(iphone14Pro.system)
    expect(value).toContain(`${iphone14Pro.screen.width}x${iphone14Pro.screen.height}`)
    expect(value).toContain(`${iphone14Pro.screen.width}×${iphone14Pro.screen.height}`)
  })
})
