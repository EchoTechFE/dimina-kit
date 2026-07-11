import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectedWxmlPanel } from './connected-panel.js'
import type { WxmlPanelSource } from './panel-source.js'
import type { WxmlNode } from './types.js'

const TREE_A: WxmlNode = { tagName: 'view', attrs: {}, children: [], sid: 'sid-a' }
const TREE_B: WxmlNode = { tagName: 'text', attrs: {}, children: [], sid: 'sid-b' }

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * A programmable WxmlPanelSource: getSnapshot() consumes one queued promise
 * per call (defaulting to `null`), subscribe() records the latest push
 * callback so tests can simulate a live tree, and every method is a spy so
 * call count / order / arguments can be asserted.
 */
function createFakeSource() {
  const unsubscribe = vi.fn()
  const getSnapshotQueue: Array<Promise<WxmlNode | null>> = []
  let latestOnTree: ((tree: WxmlNode | null) => void) | null = null
  const source: WxmlPanelSource = {
    getSnapshot: vi.fn(() => getSnapshotQueue.shift() ?? Promise.resolve(null)),
    subscribe: vi.fn((onTree: (tree: WxmlNode | null) => void) => {
      latestOnTree = onTree
      return unsubscribe
    }),
    setActive: vi.fn(),
    inspect: vi.fn(async () => null),
    clearInspection: vi.fn(),
  }
  return {
    source,
    unsubscribe,
    getSnapshotQueue,
    pushTree: (tree: WxmlNode | null) => latestOnTree?.(tree),
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

describe('ConnectedWxmlPanel', () => {
  it('seeds the tree via getSnapshot once when enabled and active are true from mount', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    render(<ConnectedWxmlPanel source={source} />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(source.subscribe).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-wxml-sid="sid-a"]')).not.toBeNull()
  })

  it('never calls getSnapshot, subscribe, or setActive while disabled', async () => {
    const { source } = createFakeSource()
    render(<ConnectedWxmlPanel source={source} enabled={false} />)
    await flush()
    expect(source.getSnapshot).not.toHaveBeenCalled()
    expect(source.subscribe).not.toHaveBeenCalled()
    expect(source.setActive).not.toHaveBeenCalled()
  })

  it('forwards isRuntimeRunning to the empty state while no tree has arrived yet', () => {
    const { source } = createFakeSource()
    render(<ConnectedWxmlPanel source={source} enabled={false} isRuntimeRunning={false} />)
    expect(screen.getByTestId('wxml-panel').textContent).toContain('小程序未运行')
  })

  it('renders live tree pushes from subscribe without issuing another getSnapshot call', async () => {
    const { source, getSnapshotQueue, pushTree } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    render(<ConnectedWxmlPanel source={source} />)
    await flush()

    act(() => {
      pushTree(TREE_B)
    })

    expect(document.querySelector('[data-wxml-sid="sid-b"]')).not.toBeNull()
    expect(document.querySelector('[data-wxml-sid="sid-a"]')).toBeNull()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes but keeps the last rendered tree when enabled flips to false', async () => {
    const { source, unsubscribe, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    const { rerender } = render(<ConnectedWxmlPanel source={source} />)
    await flush()

    rerender(<ConnectedWxmlPanel source={source} enabled={false} />)
    await flush()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-wxml-sid="sid-a"]')).not.toBeNull()
  })

  it('forwards setActive on both directions of an active flip while enabled', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    const { rerender } = render(<ConnectedWxmlPanel source={source} active />)
    await flush()

    rerender(<ConnectedWxmlPanel source={source} active={false} />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(false)

    rerender(<ConnectedWxmlPanel source={source} active />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(true)
  })

  it('re-seeds via getSnapshot on the active false-to-true rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    const { rerender } = render(<ConnectedWxmlPanel source={source} active />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    rerender(<ConnectedWxmlPanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    getSnapshotQueue.push(Promise.resolve(TREE_B))
    rerender(<ConnectedWxmlPanel source={source} active />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-wxml-sid="sid-b"]')).not.toBeNull()
  })

  it('calls setActive(false) and unsubscribes on unmount', async () => {
    const { source, unsubscribe, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    const { unmount } = render(<ConnectedWxmlPanel source={source} />)
    await flush()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(source.setActive).toHaveBeenLastCalledWith(false)
  })

  it('forwards hover inspect(sid) calls to the source', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    render(<ConnectedWxmlPanel source={source} />)
    await flush()

    const row = document.querySelector('[data-wxml-sid="sid-a"]') as HTMLElement
    fireEvent.mouseEnter(row)
    await flush()

    expect(source.inspect).toHaveBeenCalledWith('sid-a')
  })

  it('clears the inspection when the mouse leaves the panel root', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(TREE_A))
    render(<ConnectedWxmlPanel source={source} />)
    await flush()

    fireEvent.mouseLeave(screen.getByTestId('wxml-panel'))

    expect(source.clearInspection).toHaveBeenCalledTimes(1)
  })

  it('does not warn or throw when getSnapshot resolves after the component has unmounted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, getSnapshotQueue } = createFakeSource()
    const deferred = createDeferred<WxmlNode | null>()
    getSnapshotQueue.push(deferred.promise)
    const { unmount } = render(<ConnectedWxmlPanel source={source} />)

    unmount()

    await act(async () => {
      deferred.resolve(TREE_A)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('tears down the old source and re-seeds/re-subscribes the new one when source changes', async () => {
    const first = createFakeSource()
    first.getSnapshotQueue.push(Promise.resolve(TREE_A))
    const { rerender } = render(<ConnectedWxmlPanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve(TREE_B))
    rerender(<ConnectedWxmlPanel source={second.source} />)
    await flush()

    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.source.setActive).toHaveBeenLastCalledWith(false)
    expect(second.source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(second.source.subscribe).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-wxml-sid="sid-b"]')).not.toBeNull()
  })
})
