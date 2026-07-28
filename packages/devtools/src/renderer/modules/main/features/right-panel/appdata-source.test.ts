/**
 * appdata-source: renderer wiring for the AppData panel's editable write-back.
 *
 * `createIpcAppDataPanelSource()` must grow a `setData(bridgeId, patch)` method
 * that round-trips through the single ipc-transport touchpoint onto
 * `SimulatorAppDataChannel.SetData`, mirroring `getSnapshot`/`subscribe`'s
 * existing invoke/on wiring. The main-process handler (simulator-appdata
 * service) then forwards the patch to the owning service-host window, which
 * applies it via `page.setData(data)`.
 *
 * `setData` is not yet part of the `AppDataPanelSource` shape this file
 * exports against, so the source object is read through an untyped view —
 * a missing `setData` (undefined, not a function) is exactly the
 * "not implemented yet" signal these tests are meant to fail on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, onMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  onMock: vi.fn(() => () => {}),
}))

vi.mock('@/shared/api/ipc-transport', () => ({
  invoke: invokeMock,
  on: onMock,
}))

import { SimulatorAppDataChannel } from '../../../../../shared/ipc-channels'
import { createIpcAppDataPanelSource } from './appdata-source'

type SetDataFn = (bridgeId: string, patch: Record<string, unknown>) => Promise<boolean>

function sourceWithSetData() {
  return createIpcAppDataPanelSource() as unknown as { setData?: SetDataFn }
}

beforeEach(() => {
  invokeMock.mockReset()
  onMock.mockClear()
})

describe('createIpcAppDataPanelSource — setData', () => {
  it('exposes a setData(bridgeId, patch) function on the returned source', () => {
    expect(typeof sourceWithSetData().setData).toBe('function')
  })

  it("invokes SimulatorAppDataChannel.SetData with { bridgeId, data: patch }", async () => {
    invokeMock.mockResolvedValue(true)
    const setData = sourceWithSetData().setData!

    await setData('b1', { count: 5 })

    const untypedChannel = SimulatorAppDataChannel as Record<string, string>
    expect(invokeMock).toHaveBeenCalledWith(untypedChannel.SetData, {
      bridgeId: 'b1',
      data: { count: 5 },
    })
  })

  it('resolves the boolean the transport invoke resolves with', async () => {
    invokeMock.mockResolvedValue(false)
    const setData = sourceWithSetData().setData!

    await expect(setData('b1', { a: 1 })).resolves.toBe(false)
  })

  it('resolves false when the transport invoke resolves undefined (no throw)', async () => {
    invokeMock.mockResolvedValue(undefined)
    const setData = sourceWithSetData().setData!

    await expect(setData('b1', { a: 1 })).resolves.toBe(false)
  })

  it('resolves false when the transport invoke resolves null (no throw)', async () => {
    invokeMock.mockResolvedValue(null)
    const setData = sourceWithSetData().setData!

    await expect(setData('b1', { a: 1 })).resolves.toBe(false)
  })
})
