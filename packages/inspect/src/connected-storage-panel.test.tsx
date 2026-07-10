import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConnectedStoragePanel } from './connected-storage-panel.js'
import type { StoragePanelSource } from './storage-source.js'
import type { StorageEvent, StorageItem, StorageWriteResult } from './storage-types.js'

const OK: StorageWriteResult = { ok: true }

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * A programmable StoragePanelSource: getSnapshot() consumes one queued
 * promise per call (defaulting to an empty list), subscribe() records the
 * latest push callback so tests can simulate live StorageEvents, and every
 * method is a spy so call count / order / arguments can be asserted.
 * clearAll is intentionally omitted by default — tests that need it attach
 * it explicitly to exercise the optional-capability contract.
 */
function createFakeSource() {
  const unsubscribe = vi.fn()
  const getSnapshotQueue: Array<Promise<StorageItem[]>> = []
  let latestOnEvent: ((evt: StorageEvent) => void) | null = null
  const source: StoragePanelSource = {
    getSnapshot: vi.fn(() => getSnapshotQueue.shift() ?? Promise.resolve([])),
    subscribe: vi.fn((onEvent: (evt: StorageEvent) => void) => {
      latestOnEvent = onEvent
      return unsubscribe
    }),
    setActive: vi.fn(),
    setItem: vi.fn(async () => OK),
    removeItem: vi.fn(async () => OK),
    clear: vi.fn(async () => OK),
    getPrefix: vi.fn(async () => 'appid_'),
  }
  return {
    source,
    unsubscribe,
    getSnapshotQueue,
    pushEvent: (evt: StorageEvent) => latestOnEvent?.(evt),
  }
}

/** Flushes the microtask queue inside `act` so promise-driven setState calls settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConnectedStoragePanel: seeding', () => {
  it('seeds items via getSnapshot exactly once when enabled and active are true from mount', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'foo', value: 'bar' }]))
    render(<ConnectedStoragePanel source={source} />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    await screen.findByText('foo')
  })

  it('does not call getSnapshot while inactive, then seeds on the active rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    const { rerender } = render(<ConnectedStoragePanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).not.toHaveBeenCalled()

    rerender(<ConnectedStoragePanel source={source} active />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    await screen.findByText('a')
  })

  it('re-seeds via getSnapshot on the second active false-to-true rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    const { rerender } = render(<ConnectedStoragePanel source={source} active />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    rerender(<ConnectedStoragePanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    getSnapshotQueue.push(Promise.resolve([{ key: 'b', value: '2' }]))
    rerender(<ConnectedStoragePanel source={source} active />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(2)
    await screen.findByText('b')
  })

  it('makes zero source calls while disabled', async () => {
    const { source } = createFakeSource()
    render(<ConnectedStoragePanel source={source} enabled={false} />)
    await flush()

    expect(source.getSnapshot).not.toHaveBeenCalled()
    expect(source.subscribe).not.toHaveBeenCalled()
    expect(source.setActive).not.toHaveBeenCalled()
  })
})

describe('ConnectedStoragePanel: live events', () => {
  it('applies pushed added/updated/removed/cleared events to the rendered list', async () => {
    const { source, getSnapshotQueue, pushEvent } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    render(<ConnectedStoragePanel source={source} />)
    await flush()
    await screen.findByText('a')

    act(() => {
      pushEvent({ type: 'added', key: 'b', newValue: '2' })
    })
    await screen.findByText('b')

    act(() => {
      pushEvent({ type: 'updated', key: 'a', oldValue: '1', newValue: '99' })
    })
    await screen.findByText('99')

    act(() => {
      pushEvent({ type: 'removed', key: 'b' })
    })
    await waitFor(() => expect(screen.queryByText('b')).toBeNull())

    act(() => {
      pushEvent({ type: 'cleared' })
    })
    await screen.findByText('暂无 Storage 数据')
  })
})

describe('ConnectedStoragePanel: visibility and lifecycle', () => {
  it('forwards active prop changes to source.setActive in both directions', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([]))
    const { rerender } = render(<ConnectedStoragePanel source={source} active />)
    await flush()

    rerender(<ConnectedStoragePanel source={source} active={false} />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(false)

    rerender(<ConnectedStoragePanel source={source} active />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(true)
  })

  it('calls setActive(false) and unsubscribes on unmount', async () => {
    const { source, unsubscribe, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([]))
    const { unmount } = render(<ConnectedStoragePanel source={source} />)
    await flush()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(source.setActive).toHaveBeenLastCalledWith(false)
  })

  it('tears down the old source and reseeds/resubscribes the new one on a source swap', async () => {
    const first = createFakeSource()
    first.getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    const { rerender } = render(<ConnectedStoragePanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve([{ key: 'b', value: '2' }]))
    rerender(<ConnectedStoragePanel source={second.source} />)
    await flush()

    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.source.setActive).toHaveBeenLastCalledWith(false)
    expect(second.source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(second.source.subscribe).toHaveBeenCalledTimes(1)
    await screen.findByText('b')
  })
})

describe('ConnectedStoragePanel: stale resolutions', () => {
  it('drops a late getSnapshot resolution after unmount without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, getSnapshotQueue } = createFakeSource()
    const deferred = createDeferred<StorageItem[]>()
    getSnapshotQueue.push(deferred.promise)
    const { unmount } = render(<ConnectedStoragePanel source={source} />)

    unmount()

    await act(async () => {
      deferred.resolve([{ key: 'late', value: 'x' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('drops a late getSnapshot resolution after a source swap without rendering stale data', async () => {
    const first = createFakeSource()
    const deferred = createDeferred<StorageItem[]>()
    first.getSnapshotQueue.push(deferred.promise)
    const { rerender } = render(<ConnectedStoragePanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve([{ key: 'fresh', value: '1' }]))
    rerender(<ConnectedStoragePanel source={second.source} />)
    await flush()
    await screen.findByText('fresh')

    await act(async () => {
      deferred.resolve([{ key: 'stale', value: 'x' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('stale')).toBeNull()
  })
})

describe('ConnectedStoragePanel: write operations', () => {
  it('calls source.removeItem with the row key when its delete control is clicked', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'doomed', value: 'x' }]))
    render(<ConnectedStoragePanel source={source} />)
    await screen.findByText('doomed')

    const deleteBtn = screen.getByTitle('删除')
    fireEvent.click(deleteBtn)

    await waitFor(() => expect(source.removeItem).toHaveBeenCalledWith('doomed'))
  })
})

describe('ConnectedStoragePanel: clearAll optionality', () => {
  it('does not render a "清空所有" button when the source has no clearAll', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    render(<ConnectedStoragePanel source={source} />)
    await screen.findByText('a')

    expect(screen.queryByText('清空所有')).toBeNull()
  })

  it('renders and wires a "清空所有" button when the source provides clearAll', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'a', value: '1' }]))
    const clearAll = vi.fn(async () => OK)
    source.clearAll = clearAll
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(<ConnectedStoragePanel source={source} />)
    await screen.findByText('a')

    const btn = screen.getByText('清空所有')
    fireEvent.click(btn)

    await waitFor(() => expect(clearAll).toHaveBeenCalledTimes(1))
  })
})

describe('ConnectedStoragePanel: disabled retains last render', () => {
  it('keeps the last rendered items visible when enabled flips to false', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve([{ key: 'kept', value: '1' }]))
    const { rerender } = render(<ConnectedStoragePanel source={source} />)
    await screen.findByText('kept')

    rerender(<ConnectedStoragePanel source={source} enabled={false} />)
    await flush()

    expect(screen.getByText('kept')).not.toBeNull()
  })
})
