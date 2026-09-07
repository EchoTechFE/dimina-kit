/**
 * DevicePicker: the searchable device selector behind the simulator toolbar's
 * device button. It renders inside the device-picker overlay WebContentsView,
 * which mounts it only while the panel is shown — so the component is always
 * open, takes the whole device table as a prop, and reports the outcome
 * through `onSelect` / `onClose` instead of owning an open/closed state.
 *
 * Invariants this suite locks in:
 * - every device in the table it is given is offered (the full
 *   `@devicekit/devices` set, not the CLASSIC_DEVICES subset);
 * - each option row carries `aria-label` equal to the device's bare `name`, so
 *   rows sharing a prefix ("iPhone 14" vs "iPhone 14 Pro") stay unambiguous to
 *   query, and `data-current="true"` marks the active device;
 * - the active device starts highlighted, so Enter on a fresh open keeps the
 *   current device instead of jumping to the first row.
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
    onClose: () => void
  }> = {},
) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  const device = overrides.device ?? DEFAULT_DEVICE
  const devices = overrides.devices ?? DEVICES
  render(
    <DevicePicker device={device} devices={devices} onSelect={onSelect} onClose={onClose} />,
  )
  return { onSelect, onClose, device, devices }
}

describe('DevicePicker: full device table', () => {
  it('renders all 171 devices from @devicekit/devices as options once opened', async () => {
    renderPicker()

    expect(await screen.findAllByRole('option')).toHaveLength(DEVICES.length)
  })
})

describe('DevicePicker: search', () => {
  it('narrows to Galaxy Tab S9 when searching "tab s9"', async () => {
    renderPicker()

    const input = await screen.findByPlaceholderText('搜索机型：名称 / 系统 / 尺寸')
    fireEvent.change(input, { target: { value: 'tab s9' } })

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveAccessibleName(DEVICE_NAMES.Galaxy_Tab_S9)
  })

  it('matches the size typed with the × the row displays, not only ASCII x', async () => {
    renderPicker()

    const input = await screen.findByPlaceholderText('搜索机型：名称 / 系统 / 尺寸')
    fireEvent.change(input, { target: { value: '393×852' } })

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-label'))).toContain(DEVICE_NAMES.iPhone_14_Pro)
  })
})

describe('DevicePicker: 平板 form-factor chip', () => {
  it('shows only formFactor=tablet devices once toggled on', async () => {
    renderPicker()
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
    await screen.findAllByRole('option')

    fireEvent.click(screen.getByRole('button', { name: 'iOS' }))

    const expectedCount = DEVICES.filter((d) => d.os === 'ios').length
    expect(await screen.findAllByRole('option')).toHaveLength(expectedCount)
    expect(screen.queryByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })).not.toBeInTheDocument()
  })
})

describe('DevicePicker: selecting a device', () => {
  it('reports the picked device by name and does not report a dismissal', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    renderPicker({ onSelect, onClose })

    const row = await screen.findByRole('option', { name: DEVICE_NAMES.iPhone_14_Pro })
    fireEvent.click(row)

    expect(onSelect).toHaveBeenCalledWith(DEVICE_NAMES.iPhone_14_Pro)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('DevicePicker: current-device marker', () => {
  it('marks only the row for the currently active device', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    renderPicker({ device: current })

    const currentRow = await screen.findByRole('option', { name: current.name })
    expect(currentRow).toHaveAttribute('data-current', 'true')

    const otherRow = screen.getByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })
    expect(otherRow).not.toHaveAttribute('data-current', 'true')
  })

  it('pre-highlights the current device on open so Enter keeps it instead of the first row', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    renderPicker({ device: current })

    const currentRow = await screen.findByRole('option', { name: current.name })
    expect(currentRow).toHaveAttribute('aria-selected', 'true')
    const firstRow = screen.getByRole('option', { name: DEVICE_NAMES.iPhone_SE })
    expect(firstRow).not.toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on a fresh open re-selects the current device', async () => {
    const current = findDevice(DEVICE_NAMES.iPhone_14_Pro)!
    const { onSelect } = renderPicker({ device: current })

    const input = await screen.findByRole('combobox')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(current.name)
  })
})

describe('DevicePicker: dialog accessibility and dismissal', () => {
  it('names the dialog for assistive tech', async () => {
    renderPicker()
    expect(await screen.findByRole('dialog', { name: '选择机型' })).toBeInTheDocument()
  })

  it('Escape reports a dismissal without selecting', async () => {
    const { onSelect, onClose } = renderPicker()
    const dialog = await screen.findByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSelect).not.toHaveBeenCalled()
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
