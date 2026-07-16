import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectedCompilePanel } from './connected-compile-panel.js'
import type { CompileFeedEvent, CompileFeedSnapshot, CompilePanelSource } from './compile-source.js'
import type { CompileEvent, CompileLogEntry } from './compile-types.js'

const EMPTY_SNAPSHOT: CompileFeedSnapshot = { events: [], logs: [] }

function evt(overrides: Partial<CompileEvent> = {}): CompileEvent {
  return { at: 1000, status: 'compiling', message: 'building', ...overrides }
}
function logEntry(overrides: Partial<CompileLogEntry> = {}): CompileLogEntry {
  return { at: 1000, stream: 'stdout', text: 'line', ...overrides }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * A programmable CompilePanelSource: getSnapshot() consumes one queued
 * promise per call (defaulting to an empty feed), subscribe() records the
 * latest push callback so tests can simulate live CompileFeedEvents, and
 * every method is a spy. `clear` is intentionally omitted by default — tests
 * that need it attach it explicitly to exercise the optional-capability
 * contract.
 */
function createFakeSource() {
  const unsubscribe = vi.fn()
  const getSnapshotQueue: Array<Promise<CompileFeedSnapshot>> = []
  let latestOnEvent: ((evt: CompileFeedEvent) => void) | null = null
  const source: CompilePanelSource = {
    getSnapshot: vi.fn(() => getSnapshotQueue.shift() ?? Promise.resolve(EMPTY_SNAPSHOT)),
    subscribe: vi.fn((onEvent: (evt: CompileFeedEvent) => void) => {
      latestOnEvent = onEvent
      return unsubscribe
    }),
    setActive: vi.fn(),
  }
  return {
    source,
    unsubscribe,
    getSnapshotQueue,
    pushFeed: (feedEvent: CompileFeedEvent) => latestOnEvent?.(feedEvent),
  }
}

/** Flushes the microtask queue inside `act` so promise-driven setState calls settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function rowsOf(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-compile-row]'))
}
function logsOf(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-compile-log]'))
}
function timelineOf(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-compile-row], [data-compile-log]'))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConnectedCompilePanel: seeding', () => {
  it('seeds via getSnapshot exactly once when enabled and active are true from mount', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'first build' })], logs: [] }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(rowsOf().some((r) => r.textContent?.includes('first build'))).toBe(true)
  })

  it('seeds only on the active rising edge, and re-seeds on every subsequent rising edge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'A' })], logs: [] }))
    const { rerender } = render(<ConnectedCompilePanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).not.toHaveBeenCalled()

    rerender(<ConnectedCompilePanel source={source} active />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(rowsOf().some((r) => r.textContent?.includes('A'))).toBe(true)

    rerender(<ConnectedCompilePanel source={source} active={false} />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(1)

    getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'B' })], logs: [] }))
    rerender(<ConnectedCompilePanel source={source} active />)
    await flush()
    expect(source.getSnapshot).toHaveBeenCalledTimes(2)
    expect(rowsOf().some((r) => r.textContent?.includes('B'))).toBe(true)
  })

  it('makes zero source calls while disabled', async () => {
    const { source } = createFakeSource()
    render(<ConnectedCompilePanel source={source} enabled={false} />)
    await flush()

    expect(source.getSnapshot).not.toHaveBeenCalled()
    expect(source.subscribe).not.toHaveBeenCalled()
    expect(source.setActive).not.toHaveBeenCalled()
  })

  it('replaces (not merges) the rendered lists on a fresh seed', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ message: 'old event' })],
      logs: [logEntry({ text: 'old log' })],
    }))
    const { rerender } = render(<ConnectedCompilePanel source={source} active />)
    await flush()
    expect(rowsOf().some((r) => r.textContent?.includes('old event'))).toBe(true)

    rerender(<ConnectedCompilePanel source={source} active={false} />)
    await flush()
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ message: 'new event' })],
      logs: [logEntry({ text: 'new log' })],
    }))
    rerender(<ConnectedCompilePanel source={source} active />)
    await flush()

    expect(rowsOf().some((r) => r.textContent?.includes('old event'))).toBe(false)
    expect(logsOf().some((r) => r.textContent?.includes('old log'))).toBe(false)
    expect(rowsOf().some((r) => r.textContent?.includes('new event'))).toBe(true)
    expect(logsOf().some((r) => r.textContent?.includes('new log'))).toBe(true)
  })
})

describe('ConnectedCompilePanel: stale resolutions', () => {
  it('drops a late getSnapshot resolution after unmount without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, getSnapshotQueue } = createFakeSource()
    const deferred = createDeferred<CompileFeedSnapshot>()
    getSnapshotQueue.push(deferred.promise)
    const { unmount } = render(<ConnectedCompilePanel source={source} />)

    unmount()

    await act(async () => {
      deferred.resolve({ events: [evt({ message: 'late' })], logs: [] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('drops a late getSnapshot resolution after a source swap without rendering stale data', async () => {
    const first = createFakeSource()
    const deferred = createDeferred<CompileFeedSnapshot>()
    first.getSnapshotQueue.push(deferred.promise)
    const { rerender } = render(<ConnectedCompilePanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'fresh' })], logs: [] }))
    rerender(<ConnectedCompilePanel source={second.source} />)
    await flush()
    expect(rowsOf().some((r) => r.textContent?.includes('fresh'))).toBe(true)

    await act(async () => {
      deferred.resolve({ events: [evt({ message: 'stale' })], logs: [] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(rowsOf().some((r) => r.textContent?.includes('stale'))).toBe(false)
  })
})

describe('ConnectedCompilePanel: visibility and lifecycle', () => {
  it('forwards active prop changes to source.setActive in both directions', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(EMPTY_SNAPSHOT))
    const { rerender } = render(<ConnectedCompilePanel source={source} active />)
    await flush()

    rerender(<ConnectedCompilePanel source={source} active={false} />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(false)

    rerender(<ConnectedCompilePanel source={source} active />)
    await flush()
    expect(source.setActive).toHaveBeenLastCalledWith(true)
  })

  it('calls setActive(false) and unsubscribes on unmount', async () => {
    const { source, unsubscribe, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve(EMPTY_SNAPSHOT))
    const { unmount } = render(<ConnectedCompilePanel source={source} />)
    await flush()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(source.setActive).toHaveBeenLastCalledWith(false)
  })

  it('tears down the old source and reseeds/resubscribes the new one on a source swap', async () => {
    const first = createFakeSource()
    first.getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'A' })], logs: [] }))
    const { rerender } = render(<ConnectedCompilePanel source={first.source} />)
    await flush()

    const second = createFakeSource()
    second.getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'B' })], logs: [] }))
    rerender(<ConnectedCompilePanel source={second.source} />)
    await flush()

    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.source.setActive).toHaveBeenLastCalledWith(false)
    expect(second.source.getSnapshot).toHaveBeenCalledTimes(1)
    expect(second.source.subscribe).toHaveBeenCalledTimes(1)
    expect(rowsOf().some((r) => r.textContent?.includes('B'))).toBe(true)
  })
})

describe('ConnectedCompilePanel: live push merge', () => {
  it('appends a pushed event to the event list alongside the seeded ones', async () => {
    const { source, getSnapshotQueue, pushFeed } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({ events: [evt({ message: 'seeded' })], logs: [] }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    act(() => {
      pushFeed({ kind: 'event', event: evt({ at: 2000, message: 'pushed' }) })
    })

    expect(rowsOf()).toHaveLength(2)
    expect(rowsOf().some((r) => r.textContent?.includes('pushed'))).toBe(true)
  })

  it('appends a pushed log to the log list alongside the seeded ones', async () => {
    const { source, getSnapshotQueue, pushFeed } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({ events: [], logs: [logEntry({ text: 'seeded log' })] }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    act(() => {
      pushFeed({ kind: 'log', log: logEntry({ at: 2000, text: 'pushed log' }) })
    })

    expect(logsOf()).toHaveLength(2)
    expect(logsOf().some((r) => r.textContent?.includes('pushed log'))).toBe(true)
  })

  it('clears both lists back to the empty state on a reset push', async () => {
    const { source, getSnapshotQueue, pushFeed } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ message: 'gone event' })],
      logs: [logEntry({ text: 'gone log' })],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()
    expect(rowsOf()).toHaveLength(1)

    act(() => {
      pushFeed({ kind: 'reset' })
    })

    expect(rowsOf()).toHaveLength(0)
    expect(logsOf()).toHaveLength(0)
    expect(screen.getByText('暂无编译信息')).not.toBeNull()
  })
})

describe('ConnectedCompilePanel: FIFO caps', () => {
  it('caps events at the newest 200 and logs at the newest 300, evicting the oldest on overflow', async () => {
    const { source, pushFeed } = createFakeSource()
    render(<ConnectedCompilePanel source={source} />)
    await flush()
    act(() => {
      for (let i = 0; i < 201; i++) pushFeed({ kind: 'event', event: evt({ at: 1000 + i, message: `evt-${i}` }) })
      for (let i = 0; i < 301; i++) pushFeed({ kind: 'log', log: logEntry({ at: 1000 + i, text: `log-${i}` }) })
    })

    expect(rowsOf()).toHaveLength(200)
    expect(rowsOf().some((r) => r.textContent?.includes('evt-0'))).toBe(false)
    expect(rowsOf().some((r) => r.textContent?.includes('evt-200'))).toBe(true)
    expect(logsOf()).toHaveLength(300)
    expect(logsOf().some((r) => r.textContent?.includes('log-0'))).toBe(false)
    expect(logsOf().some((r) => r.textContent?.includes('log-300'))).toBe(true)
  })
})

describe('ConnectedCompilePanel: seq stamping preserves arrival order in the merged timeline', () => {
  it('renders an event before a same-tick log pushed after it, and vice versa, when neither carries a seq', async () => {
    const forward = createFakeSource()
    const { unmount } = render(<ConnectedCompilePanel source={forward.source} />)
    await flush()
    act(() => {
      forward.pushFeed({ kind: 'event', event: evt({ at: 5000, message: 'tied-event' }) })
    })
    act(() => {
      forward.pushFeed({ kind: 'log', log: logEntry({ at: 5000, text: 'tied-log' }) })
    })
    let texts = timelineOf().map((el) => el.textContent ?? '')
    expect(texts.findIndex((t) => t.includes('tied-event'))).toBeLessThan(
      texts.findIndex((t) => t.includes('tied-log')),
    )
    unmount()

    const reversed = createFakeSource()
    render(<ConnectedCompilePanel source={reversed.source} />)
    await flush()
    act(() => {
      reversed.pushFeed({ kind: 'log', log: logEntry({ at: 5000, text: 'tied-log-first' }) })
    })
    act(() => {
      reversed.pushFeed({ kind: 'event', event: evt({ at: 5000, message: 'tied-event-second' }) })
    })
    texts = timelineOf().map((el) => el.textContent ?? '')
    expect(texts.findIndex((t) => t.includes('tied-log-first'))).toBeLessThan(
      texts.findIndex((t) => t.includes('tied-event-second')),
    )
  })

  it('does not let the local seq counter undercut an explicit seq already seen', async () => {
    const { source, pushFeed } = createFakeSource()
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    // The first push carries an explicit, high seq. If the local monotonic
    // counter naively started from 0, the next (unstamped) push would be
    // assigned a lower seq and render BEFORE this one on the same `at` tick —
    // silently reversing arrival order.
    act(() => {
      pushFeed({ kind: 'event', event: evt({ at: 9000, seq: 100, message: 'explicit-seq-first' }) })
    })
    act(() => {
      pushFeed({ kind: 'log', log: logEntry({ at: 9000, text: 'auto-seq-second' }) })
    })

    const texts = timelineOf().map((el) => el.textContent ?? '')
    const eventIndex = texts.findIndex((t) => t.includes('explicit-seq-first'))
    const logIndex = texts.findIndex((t) => t.includes('auto-seq-second'))
    expect(eventIndex).toBeGreaterThanOrEqual(0)
    expect(logIndex).toBeGreaterThanOrEqual(0)
    expect(eventIndex).toBeLessThan(logIndex)
  })
})

describe('ConnectedCompilePanel: rendering contract', () => {
  it('shows the empty state text when there are no events and no logs', async () => {
    const { source } = createFakeSource()
    render(<ConnectedCompilePanel source={source} enabled={false} />)

    expect(screen.getByText('暂无编译信息')).not.toBeNull()
  })

  it('tags each event row with data-status matching its status', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ status: 'error', message: 'boom' })],
      logs: [],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    const row = rowsOf().find((r) => r.textContent?.includes('boom'))
    expect(row?.getAttribute('data-status')).toBe('error')
  })

  it('tags each log row with data-stream matching its stream', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [],
      logs: [logEntry({ stream: 'stderr', text: 'oh no' })],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    const row = logsOf().find((r) => r.textContent?.includes('oh no'))
    expect(row?.getAttribute('data-stream')).toBe('stderr')
  })

  it('reflects the latest event status/message in the current-status badge', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [
        evt({ at: 1000, status: 'compiling', message: 'building now' }),
        evt({ at: 2000, status: 'ready', message: 'build finished' }),
      ],
      logs: [],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    const badge = document.querySelector('[data-compile-current]')
    expect(badge?.textContent).toContain('build finished')
  })

  it('renders a filter input with placeholder "过滤..." and a clear button labeled "清空"', async () => {
    const { source } = createFakeSource()
    render(<ConnectedCompilePanel source={source} enabled={false} />)

    expect(screen.getByPlaceholderText('过滤...')).not.toBeNull()
    expect(screen.getByText('清空')).not.toBeNull()
  })
})

describe('ConnectedCompilePanel: duration badge on a compiling→ready pair', () => {
  it('shows a duration badge on a ready event immediately following a compiling event', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [
        evt({ at: 1000, status: 'compiling', message: 'building' }),
        evt({ at: 1500, status: 'ready', message: 'done' }),
      ],
      logs: [],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    const readyRow = rowsOf().find((r) => r.textContent?.includes('done'))
    expect(readyRow?.querySelector('[data-compile-duration]')).not.toBeNull()
  })

  it('shows no duration badge when a ready event has no immediately preceding compiling event', async () => {
    const noPredecessor = createFakeSource()
    noPredecessor.getSnapshotQueue.push(Promise.resolve({
      events: [evt({ at: 1000, status: 'ready', message: 'lone ready' })],
      logs: [],
    }))
    const { unmount } = render(<ConnectedCompilePanel source={noPredecessor.source} />)
    await flush()
    expect(
      rowsOf().find((r) => r.textContent?.includes('lone ready'))?.querySelector('[data-compile-duration]'),
    ).toBeNull()
    unmount()

    const nonCompilingPredecessor = createFakeSource()
    nonCompilingPredecessor.getSnapshotQueue.push(Promise.resolve({
      events: [
        evt({ at: 1000, status: 'compiling', message: 'building' }),
        evt({ at: 1200, status: 'error', message: 'broke' }),
        evt({ at: 1500, status: 'ready', message: 'done anyway' }),
      ],
      logs: [],
    }))
    render(<ConnectedCompilePanel source={nonCompilingPredecessor.source} />)
    await flush()
    expect(
      rowsOf().find((r) => r.textContent?.includes('done anyway'))?.querySelector('[data-compile-duration]'),
    ).toBeNull()
  })
})

describe('ConnectedCompilePanel: clear button', () => {
  it('clears both rendered lists and calls source.clear once when the source provides it', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    const clear = vi.fn(async () => {})
    source.clear = clear
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ message: 'to be cleared' })],
      logs: [logEntry({ text: 'log to be cleared' })],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    fireEvent.click(screen.getByText('清空'))
    await flush()

    expect(rowsOf()).toHaveLength(0)
    expect(logsOf()).toHaveLength(0)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('clears the rendered lists without throwing when the source has no clear', async () => {
    const { source, getSnapshotQueue } = createFakeSource()
    getSnapshotQueue.push(Promise.resolve({
      events: [evt({ message: 'to be cleared' })],
      logs: [],
    }))
    render(<ConnectedCompilePanel source={source} />)
    await flush()

    expect(() => fireEvent.click(screen.getByText('清空'))).not.toThrow()
    await flush()

    expect(rowsOf()).toHaveLength(0)
  })
})
