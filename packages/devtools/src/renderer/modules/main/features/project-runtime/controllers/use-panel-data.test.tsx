/**
 * usePanelData — Storage transport handoff.
 *
 * Pinned contract (the seed/subscribe/visibility wiring itself lives in the
 * shared ConnectedStoragePanel and is guarded by @dimina-kit/inspect's own
 * suite; THIS layer only hands it a transport + a readiness gate):
 *   - `storageEnabled` mirrors `compileStatus.status === 'ready'` — the gate
 *     that makes an already-mounted Storage tab seed exactly when the session
 *     becomes ready, with no caller-driven refresh call anywhere.
 *   - `storageSource` (and `wxmlSource`) keep a STABLE identity across
 *     re-renders: the connected containers key their subscription and their
 *     rising-edge seed on the source reference, so a fresh object per render
 *     would tear down / re-seed on every commit.
 *   - `storageSource` maps the source operations onto the simulator-storage
 *     IPC channels (snapshot fetch, write ops payload shape, event
 *     subscription, prefix lookup) — the whole Electron-host transport.
 */
import { renderHook } from '@testing-library/react'
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

describe('usePanelData — readiness gate', () => {
  it('reports storageEnabled/wxmlEnabled false before ready and true once ready', () => {
    const { result, rerender } = renderHook(
      ({ compileStatus }: { compileStatus: CompileStatus }) => usePanelData({ compileStatus }),
      { initialProps: { compileStatus: COMPILING } },
    )
    expect(result.current.storageEnabled).toBe(false)
    expect(result.current.wxmlEnabled).toBe(false)

    rerender({ compileStatus: READY })

    expect(result.current.storageEnabled).toBe(true)
    expect(result.current.wxmlEnabled).toBe(true)
  })
})

describe('usePanelData — source identity', () => {
  it('keeps the same storageSource/wxmlSource references across re-renders', () => {
    const { result, rerender } = renderHook(
      ({ compileStatus }: { compileStatus: CompileStatus }) => usePanelData({ compileStatus }),
      { initialProps: { compileStatus: COMPILING } },
    )
    const firstStorage = result.current.storageSource
    const firstWxml = result.current.wxmlSource

    rerender({ compileStatus: READY })

    expect(result.current.storageSource).toBe(firstStorage)
    expect(result.current.wxmlSource).toBe(firstWxml)
  })
})

describe('usePanelData — storageSource IPC transport', () => {
  it('getSnapshot invokes SimulatorStorageChannel.GetSnapshot and falls back to [] on a dead transport', async () => {
    const items = [{ key: 'wxAPP_a', value: '1' }]
    invokeMock.mockImplementation((channel: string) =>
      Promise.resolve(channel === SimulatorStorageChannel.GetSnapshot ? items : undefined))
    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))

    await expect(result.current.storageSource.getSnapshot()).resolves.toEqual(items)
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.GetSnapshot)

    invokeMock.mockResolvedValue(undefined)
    await expect(result.current.storageSource.getSnapshot()).resolves.toEqual([])
  })

  it('write operations travel the Set/Remove/Clear/ClearAll channels with their payload shapes', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))
    const source = result.current.storageSource

    await expect(source.setItem('wxAPP_k', 'v')).resolves.toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.Set, { key: 'wxAPP_k', value: 'v' })

    await source.removeItem('wxAPP_k')
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.Remove, { key: 'wxAPP_k' })

    await source.clear()
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.Clear)

    await source.clearAll?.()
    expect(invokeMock).toHaveBeenCalledWith(SimulatorStorageChannel.ClearAll)
  })

  it('a failed write resolves to an { ok: false } result instead of throwing', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))

    await expect(result.current.storageSource.setItem('k', 'v'))
      .resolves.toEqual({ ok: false, error: 'ipc transport failed' })
  })

  it('subscribe listens on SimulatorStorageChannel.Event and returns the transport unsubscriber', async () => {
    const stop = vi.fn()
    onMock.mockReturnValue(stop)
    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))
    const onEvent = vi.fn()

    const unsubscribe = result.current.storageSource.subscribe(onEvent)

    expect(onMock).toHaveBeenCalledWith(SimulatorStorageChannel.Event, onEvent)
    unsubscribe()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('getPrefix invokes GetActivePrefix and falls back to the empty prefix', async () => {
    invokeMock.mockImplementation((channel: string) =>
      Promise.resolve(channel === SimulatorStorageChannel.GetActivePrefix ? 'wxAPP_' : undefined))
    const { result } = renderHook(() => usePanelData({ compileStatus: READY }))

    await expect(result.current.storageSource.getPrefix()).resolves.toBe('wxAPP_')

    invokeMock.mockResolvedValue(undefined)
    await expect(result.current.storageSource.getPrefix()).resolves.toBe('')
  })
})
