/**
 * usePanelData — Storage ready-seed.
 *
 * Pinned contract:
 *   - WXML + AppData already auto-seed via `useNativeChannelSnapshot`'s
 *     `enabled: ready` effect, but Storage has its own hand-rolled state
 *     (`storageItems` + `refreshStorage`) that historically only populated on
 *     a manual refresh-button click. Now that the refresh button is gone,
 *     an already-mounted Storage tab that was empty pre-compile would
 *     stay empty forever without an explicit ready-edge seed.
 *   - `usePanelData` must auto-invoke `SimulatorStorageChannel.GetSnapshot`
 *     as soon as `compileStatus.status === 'ready'`, with NO caller-driven
 *     `refreshStorage()` call required.
 *   - Before ready, it must NOT invoke GetSnapshot at all.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, onMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  onMock: vi.fn(() => () => {}),
}))

vi.mock('@/shared/api/ipc-transport', () => ({
  invoke: invokeMock,
  on: onMock,
}))

import { SimulatorStorageChannel } from '../../../../../../shared/ipc-channels'
import { usePanelData } from './use-panel-data'
import type { CompileStatus } from './use-project-runtime-controller'

const READY: CompileStatus = { status: 'ready', message: '编译完成' }
const COMPILING: CompileStatus = { status: 'compiling', message: '' }

beforeEach(() => {
  invokeMock.mockReset()
  onMock.mockClear()
  invokeMock.mockResolvedValue(undefined)
})

describe('usePanelData — Storage ready-seed', () => {
  it('auto-invokes SimulatorStorageChannel.GetSnapshot and populates storageItems once ready, without a manual refreshStorage() call', async () => {
    const items = [{ key: 'wxAPP_a', value: '1' }]
    invokeMock.mockImplementation((channel: string) => {
      if (channel === SimulatorStorageChannel.GetSnapshot) return Promise.resolve(items)
      return Promise.resolve(undefined)
    })

    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))

    // No call to result.current.refreshStorage() anywhere in this test — the
    // seed must be automatic.
    await waitFor(() => {
      expect(result.current.storageItems).toEqual(items)
    })
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.GetSnapshot)
  })

  it('does NOT invoke GetSnapshot while compileStatus is not ready', async () => {
    renderHook(() => usePanelData({ compileStatus: COMPILING }))

    // Give any (incorrect) eager fetch a chance to fire.
    await Promise.resolve()
    await Promise.resolve()

    expect(invokeMock).not.toHaveBeenCalledWith(SimulatorStorageChannel.GetSnapshot)
  })

  it('seeds when compileStatus transitions from not-ready to ready', async () => {
    const items = [{ key: 'wxAPP_b', value: '2' }]
    invokeMock.mockImplementation((channel: string) => {
      if (channel === SimulatorStorageChannel.GetSnapshot) return Promise.resolve(items)
      return Promise.resolve(undefined)
    })

    const { result, rerender } = renderHook(
      ({ compileStatus }: { compileStatus: CompileStatus }) => usePanelData({ compileStatus }),
      { initialProps: { compileStatus: COMPILING } },
    )
    expect(result.current.storageItems).toEqual([])

    rerender({ compileStatus: READY })

    await waitFor(() => {
      expect(result.current.storageItems).toEqual(items)
    })
  })
})
