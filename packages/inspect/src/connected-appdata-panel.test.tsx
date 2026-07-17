import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ConnectedAppDataPanel } from './connected-appdata-panel.js'
import type { AppDataPanelSource } from './appdata-source.js'
import type { AppDataSnapshot } from './appdata-accumulator.js'

const EMPTY_SNAPSHOT: AppDataSnapshot = { bridges: [], entries: {} }

function snapshot(
  bridges: AppDataSnapshot['bridges'],
  entries: AppDataSnapshot['entries'] = {},
): AppDataSnapshot {
  return { bridges, entries }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * A programmable AppDataPanelSource: getSnapshot() consumes one queued
 * promise per call (defaulting to an empty snapshot), subscribe() records
 * the latest push callback so tests can simulate live AppDataSnapshots, and
 * every method is a spy so call count / order / arguments can be asserted.
 */
function createFakeSource() {
  const unsubscribe = vi.fn()
  const getSnapshotQueue: Array<Promise<AppDataSnapshot>> = []
  let latestOnSnapshot: ((snap: AppDataSnapshot) => void) | null = null
  const source: AppDataPanelSource = {
    getSnapshot: vi.fn(() => getSnapshotQueue.shift() ?? Promise.resolve(EMPTY_SNAPSHOT)),
    subscribe: vi.fn((onSnapshot: (snap: AppDataSnapshot) => void) => {
      latestOnSnapshot = onSnapshot
      return unsubscribe
    }),
    setActive: vi.fn(),
  }
  return {
    source,
    unsubscribe,
    getSnapshotQueue,
    pushSnapshot: (snap: AppDataSnapshot) => latestOnSnapshot?.(snap),
  }
}

/** Flushes the microtask queue inside `act` so promise-driven setState calls settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Finds a Pages sidebar row by its rendered label (pagePath, or id when pagePath is null). */
function pageItem(label: string): HTMLElement {
  const items = screen.getAllByTestId('appdata-page-item')
  const found = items.find(el => (el.textContent ?? '').trim() === label)
  if (!found) throw new Error(`no page item labeled "${label}" among [${items.map(el => el.textContent).join(', ')}]`)
  return found
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConnectedAppDataPanel: seeding', () => {
  it('seeds via getSnapshot exactly once when enabled and active are true from mount', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: '/pages/index/index' }], {
      b1: { 'pages/index/index': { count: 1 } },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-bridge-id="b1"]')).not.toBeNull()
  })

  it('does not call getSnapshot while inactive, then seeds on the active rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }])))
    const { rerender } = render(<ConnectedAppDataPanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).not.toHaveBeenCalled()

    rerender(<ConnectedAppDataPanel source={source} active />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('re-seeds via getSnapshot on the second active false-to-true rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }])))
    const { rerender } = render(<ConnectedAppDataPanel source={source} active />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    rerender(<ConnectedAppDataPanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b2', pagePath: null }])))
    rerender(<ConnectedAppDataPanel source={source} active />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-bridge-id="b2"]')).not.toBeNull()
  })

  it('makes zero source calls while disabled', async () => {
    const { source } = createFakeSource()
    render(<ConnectedAppDataPanel source={source} enabled={false} />)
    await flush()

    expect(source.getSnapshot).not.toHaveBeenCalled()
    expect(source.subscribe).not.toHaveBeenCalled()
    expect(source.setActive).not.toHaveBeenCalled()
  })
})

describe('ConnectedAppDataPanel: live snapshot push', () => {
  it('replaces the entire rendered snapshot when subscribe pushes a new one', async () => {
    const { source, getSnapshotQueue, pushSnapshot } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }], {
      b1: { 'pages/index/index': { count: 1 } },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()
    expect(document.querySelector('[data-bridge-id="b1"]')).not.toBeNull()

    act(() => {
      pushSnapshot(snapshot([{ id: 'b1', pagePath: null }, { id: 'b2', pagePath: null }], {
        b1: { 'pages/index/index': { count: 2 } },
        b2: { 'pages/detail/detail': { count: 9 } },
      }))
    })

    expect(document.querySelector('[data-bridge-id="b2"]')).not.toBeNull()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectedAppDataPanel: visibility and lifecycle', () => {
  it('forwards active prop changes to source.setActive in both directions', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(EMPTY_SNAPSHOT))
    const { rerender } = render(<ConnectedAppDataPanel source={source} active />)
    await flush()

    rerender(<ConnectedAppDataPanel source={source} active={false} />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(false)

    rerender(<ConnectedAppDataPanel source={source} active />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(true)
  })

  it('calls setActive(false) and unsubscribes on unmount', async () => {
    const { source, unsubscribe, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(EMPTY_SNAPSHOT))
    const { unmount } = render(<ConnectedAppDataPanel source={source} />)
    await flush()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(source.setActive).toHaveBeenLastCalledWith(false)
  })

  it('tears down the old source and reseeds/resubscribes the new one on a source swap', async () => {
    const first = createFakeSource()
    first.getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }])))
    const { rerender } = render(<ConnectedAppDataPanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b2', pagePath: null }])))
    rerender(<ConnectedAppDataPanel source={second.source} />)
    await flush()

    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.source.setActive).toHaveBeenLastCalledWith(false)
    expect(second.source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(second.source.subscribe).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-bridge-id="b2"]')).not.toBeNull()
  })
})

describe('ConnectedAppDataPanel: stale resolutions', () => {
  it('drops a late getSnapshot resolution after unmount without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, getSnapshotQueue } = createFakeSource()
    const deferred = createDeferred<AppDataSnapshot>()
    getSnapshotQueue.push(deferred.promise)
    const { unmount } = render(<ConnectedAppDataPanel source={source} />)

    unmount()

    await act(async () => {
      deferred.resolve(snapshot([{ id: 'late', pagePath: null }]))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('drops a late getSnapshot resolution after a source swap without rendering stale data', async () => {
    const first = createFakeSource()
    const deferred = createDeferred<AppDataSnapshot>()
    first.getSnapshotQueue.push(deferred.promise)
    const { rerender } = render(<ConnectedAppDataPanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'fresh', pagePath: null }])))
    rerender(<ConnectedAppDataPanel source={second.source} />)
    await flush()
    expect(document.querySelector('[data-bridge-id="fresh"]')).not.toBeNull()

    await act(async () => {
      deferred.resolve(snapshot([{ id: 'stale', pagePath: null }]))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-bridge-id="stale"]')).toBeNull()
  })
})

describe('ConnectedAppDataPanel: rendering contract', () => {
  it('shows the running-but-empty text when isRuntimeRunning is true and there is no data', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(EMPTY_SNAPSHOT))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    expect(screen.getByTestId('appdata-panel').textContent).toContain('暂无页面数据（仅显示 Page 级 data）')
  })

  it('shows the not-running text when isRuntimeRunning is false and there is no data', async () => {
    const { source } = createFakeSource()
    render(<ConnectedAppDataPanel source={source} enabled={false} isRuntimeRunning={false} />)

    expect(screen.getByTestId('appdata-panel').textContent).toContain('小程序未运行')
  })

  it('shows the empty state when bridges exist but every bridge has zero entries', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }], { b1: {} })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    expect(screen.getByTestId('appdata-panel').textContent).toContain('暂无页面数据（仅显示 Page 级 data）')
  })

  it('renders the Pages sidebar with a single item even when there is only one bridge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: '/pages/index/index' }], {
      b1: { 'pages/index/index': { count: 1 } },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    expect(screen.getByTestId('appdata-pages')).not.toBeNull()
    expect(screen.getAllByTestId('appdata-page-item')).toHaveLength(1)
  })

  it('renders one Pages sidebar item per bridge, labeled by pagePath and falling back to id when pagePath is null', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([
      { id: 'b1', pagePath: '/pages/index/index' },
      { id: 'b2', pagePath: null },
    ], {
      b1: { 'pages/index/index': { count: 1 } },
      b2: { 'pages/detail/detail': { count: 2 } },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    const labels = screen.getAllByTestId('appdata-page-item').map(el => (el.textContent ?? '').trim())
    expect(labels).toContain('/pages/index/index')
    expect(labels).toContain('b2')
  })

  it('keeps every bridge container mounted and toggles display instead of unmounting on tab switch', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([
      { id: 'b1', pagePath: '/pages/index/index' },
      { id: 'b2', pagePath: '/pages/detail/detail' },
    ], {
      b1: { 'pages/index/index': { count: 1 } },
      b2: { 'pages/detail/detail': { count: 2 } },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    const c1 = document.querySelector('[data-bridge-id="b1"]') as HTMLElement
    const c2 = document.querySelector('[data-bridge-id="b2"]') as HTMLElement
    expect(c1).not.toBeNull()
    expect(c2).not.toBeNull()
    // auto-follow with no activePagePath lands on the last bridge (b2).
    expect(c2.style.display).toBe('flex')
    expect(c1.style.display).toBe('none')

    fireEvent.click(pageItem('/pages/index/index'))

    expect(c1.style.display).toBe('flex')
    expect(c2.style.display).toBe('none')
    // Both stay mounted across the switch (keepalive) rather than being torn down.
    expect(document.querySelector('[data-bridge-id="b1"]')).toBe(c1)
    expect(document.querySelector('[data-bridge-id="b2"]')).toBe(c2)
  })

  it('merges every entry\'s data into one tree so no bridge data is lost through the connected wiring', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot([{ id: 'b1', pagePath: null }], {
      b1: {
        'pages/index/index': { count: 1 },
        'components/foo/foo': { visible: true },
      },
    })))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    const tree = within(document.querySelector('[data-bridge-id="b1"]') as HTMLElement).getByTestId('appdata-tree')
    expect(tree.textContent).toContain('count')
    expect(tree.textContent).toContain('visible')
  })
})

describe('ConnectedAppDataPanel: active bridge auto-follow', () => {
  const TWO_BRIDGES = [
    { id: 'b1', pagePath: '/pages/index/index' },
    { id: 'b2', pagePath: '/pages/detail/detail' },
  ]
  const TWO_BRIDGE_ENTRIES = {
    b1: { 'pages/index/index': { count: 1 } },
    b2: { 'pages/detail/detail': { count: 2 } },
  }

  it('selects the bridge whose pagePath matches activePagePath, ignoring a leading-slash difference', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    render(<ConnectedAppDataPanel source={source} activePagePath="pages/detail/detail" />)
    await flush()

    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('flex')
    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('none')
  })

  it('falls back to the last bridge when activePagePath matches no bridge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    render(<ConnectedAppDataPanel source={source} activePagePath="/pages/unknown/unknown" />)
    await flush()

    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('flex')
  })

  it('falls back to the last bridge when activePagePath is not provided', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('flex')
  })

  it('keeps a manually selected tab active across snapshot pushes that add no new bridge', async () => {
    const { source, getSnapshotQueue, pushSnapshot } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    fireEvent.click(pageItem('/pages/index/index'))
    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('flex')

    act(() => {
      pushSnapshot(snapshot(TWO_BRIDGES, {
        b1: { 'pages/index/index': { count: 100 } },
        b2: { 'pages/detail/detail': { count: 200 } },
      }))
    })

    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('flex')
    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('none')
  })

  it('resets the manual selection back to auto-follow when a bridge id never seen before appears', async () => {
    const { source, getSnapshotQueue, pushSnapshot } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    render(<ConnectedAppDataPanel source={source} />)
    await flush()

    fireEvent.click(pageItem('/pages/index/index'))
    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('flex')

    act(() => {
      pushSnapshot(snapshot([...TWO_BRIDGES, { id: 'b3', pagePath: '/pages/new/new' }], {
        ...TWO_BRIDGE_ENTRIES,
        b3: { 'pages/new/new': { count: 3 } },
      }))
    })

    // Auto-follow resumes: with no activePagePath, the newest (last) bridge wins again.
    expect((document.querySelector('[data-bridge-id="b3"]') as HTMLElement).style.display).toBe('flex')
    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('none')
  })

  it('resets the manual selection back to auto-follow when activePagePath changes', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(snapshot(TWO_BRIDGES, TWO_BRIDGE_ENTRIES)))
    const { rerender } = render(<ConnectedAppDataPanel source={source} activePagePath="/pages/index/index" />)
    await flush()
    expect((document.querySelector('[data-bridge-id="b1"]') as HTMLElement).style.display).toBe('flex')

    fireEvent.click(pageItem('/pages/detail/detail'))
    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('flex')

    rerender(<ConnectedAppDataPanel source={source} activePagePath="/pages/detail/detail" />)

    // The activePagePath prop change overrides the stale manual pick with the new auto-follow target.
    expect((document.querySelector('[data-bridge-id="b2"]') as HTMLElement).style.display).toBe('flex')
  })
})
