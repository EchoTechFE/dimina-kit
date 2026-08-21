/**
 * Contract under test: `setupSimulatorCurrentPage` bridges the runtime's
 * active-page signal (pagePath + query) into the main window's renderer as a
 * `pagePath?k=v&…` route payload (`SimulatorChannel.CurrentPage`), so the
 * page-path bar shows the page's params and a recompile can restore them —
 * WeChat DevTools keeps the page stack's route+query across recompiles.
 *
 *  - `activePage` events carry the route (path + query); `domReady` /
 *    `domMutated` events are ignored.
 *  - Events with no pagePath are dropped (the renderer seeds from the URL).
 *  - Unreachable hosts (destroyed) don't receive the push.
 *  - Disposing the returned registry unsubscribes the bridge listener.
 */
import { describe, it, expect, vi } from 'vitest'
import { SimulatorChannel } from '../../../shared/ipc-channels.js'
import { setupSimulatorCurrentPage } from './index.js'

interface RenderEventListener {
  (event: { kind: 'domReady' | 'activePage' | 'domMutated'; pagePath?: string; query?: Record<string, unknown> }): void
}

function makeBridge() {
  const listeners: RenderEventListener[] = []
  const off = vi.fn(() => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  })
  // Hoist before use: the registration call below reassigns `listener`.
  let listener: RenderEventListener = () => {}
  return {
    bridge: {
      onRenderEvent: vi.fn((fn: RenderEventListener) => {
        listener = fn
        listeners.push(fn)
        return off
      }),
    },
    emit(ev: Parameters<RenderEventListener>[0]): void {
      for (const fn of [...listeners]) fn(ev)
    },
  }
}

function makeHost() {
  return { send: vi.fn(), isDestroyed: () => false }
}

describe('setupSimulatorCurrentPage', () => {
  it('pushes the active page route with its query to the host renderer', () => {
    const { bridge, emit } = makeBridge()
    const host = makeHost()
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    emit({
      kind: 'activePage',
      pagePath: 'pages/detail/detail',
      query: { id: '42', tag: 'hot' },
    })

    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenCalledWith(
      SimulatorChannel.CurrentPage,
      'pages/detail/detail?id=42&tag=hot',
    )
    registry.dispose?.()
  })

  it('pushes a bare path when the active page has no query', () => {
    const { bridge, emit } = makeBridge()
    const host = makeHost()
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    emit({ kind: 'activePage', pagePath: 'pages/index/index' })

    expect(host.send).toHaveBeenCalledWith(SimulatorChannel.CurrentPage, 'pages/index/index')
    registry.dispose?.()
  })

  it('stringifies non-string query values (URL numbers arrive as numbers)', () => {
    const { bridge, emit } = makeBridge()
    const host = makeHost()
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    emit({ kind: 'activePage', pagePath: 'pages/x/x', query: { n: 42, flag: true } })

    expect(host.send).toHaveBeenCalledWith(SimulatorChannel.CurrentPage, 'pages/x/x?n=42&flag=true')
    registry.dispose?.()
  })

  it('ignores domReady / domMutated events and events without a pagePath', () => {
    const { bridge, emit } = makeBridge()
    const host = makeHost()
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    emit({ kind: 'domReady' })
    emit({ kind: 'domMutated' })
    emit({ kind: 'activePage' })

    expect(host.send).not.toHaveBeenCalled()
    registry.dispose?.()
  })

  it('skips destroyed hosts', () => {
    const { bridge, emit } = makeBridge()
    const host = { send: vi.fn(), isDestroyed: () => true }
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    emit({ kind: 'activePage', pagePath: 'pages/x/x', query: {} })

    expect(host.send).not.toHaveBeenCalled()
    registry.dispose?.()
  })

  it('disposal unsubscribes the bridge listener (no further pushes)', () => {
    const { bridge, emit } = makeBridge()
    const host = makeHost()
    const registry = setupSimulatorCurrentPage(host as never, { bridge: bridge as never })

    registry.dispose?.()
    emit({ kind: 'activePage', pagePath: 'pages/x/x' })

    expect(host.send).not.toHaveBeenCalled()
  })
})