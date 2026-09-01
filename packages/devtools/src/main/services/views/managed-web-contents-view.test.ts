/**
 * Crash/failed-load recovery for `createManagedWebContentsView` — the shared
 * lazy-create/liveness/teardown lifecycle behind host-toolbar, host-sidebar
 * and host-dialog. `liveWebContents()`'s `!isDestroyed()` check alone cannot
 * tell "alive" from "alive but broken": a crashed renderer process or a
 * failed main-frame load leaves `webContents` non-destroyed but
 * blank/unresponsive. Mirrors `overlay-panel.test.ts`'s
 * `render-process-gone`/`did-fail-load` coverage for the same failure mode.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebContents } from 'electron'

interface FakeWebContents {
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  loadFile: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
  on: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  close: ReturnType<typeof vi.fn<() => void>>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  id: number
  _fireDidFailLoad(errorCode: number, isMainFrame: boolean): void
  _fireRenderProcessGone(reason: string): void
}

let nextId = 1

function fakeWebContents(): FakeWebContents {
  let didFailLoadHandler: ((...args: never[]) => void) | undefined
  let renderProcessGoneHandler: ((...args: never[]) => void) | undefined
  let destroyed = false
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === 'did-fail-load') didFailLoadHandler = handler
      if (event === 'render-process-gone') renderProcessGoneHandler = handler
    }),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => { destroyed = true }),
    setWindowOpenHandler: vi.fn(),
    id: nextId++,
    _fireDidFailLoad(errorCode, isMainFrame) {
      ;(didFailLoadHandler as unknown as (e: unknown, c: number, d: string, u: string, m: boolean) => void)
        ?.(undefined, errorCode, 'failed', 'file:///x', isMainFrame)
    },
    _fireRenderProcessGone(reason) {
      ;(renderProcessGoneHandler as unknown as (e: unknown, d: { reason: string }) => void)
        ?.(undefined, { reason })
    },
  }
}

vi.mock('electron', () => {
  const created: FakeWebContents[] = []
  class WebContentsView {
    webContents: FakeWebContents
    setBackgroundColor = vi.fn()
    constructor() {
      this.webContents = fakeWebContents()
      created.push(this.webContents)
    }
  }
  return {
    WebContentsView,
    shell: { openExternal: vi.fn() },
    __created: created,
  }
})

vi.mock('../../windows/navigation-hardening.js', () => ({
  handleWindowOpenExternal: vi.fn(() => ({ action: 'deny' as const })),
}))

import { createManagedWebContentsView } from './managed-web-contents-view.js'
import * as electronMock from 'electron'

const created = (electronMock as unknown as { __created: FakeWebContents[] }).__created

function makeOpts(overrides: { onBroken?: () => void } = {}) {
  const destroyView = vi.fn()
  const reconciler = { destroyView } as unknown as Parameters<typeof createManagedWebContentsView>[0]['reconciler']
  // One attachment handle per attached wc, in creation order — the manager is
  // supposed to release each one when it lets go of that wc.
  const attachments: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const port = {
    attach: vi.fn(() => {
      const handle = { dispose: vi.fn() }
      attachments.push(handle)
      return handle
    }),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    onMessage: vi.fn(),
    onReady: vi.fn(),
    send: vi.fn(() => true),
  } as unknown as Parameters<typeof createManagedWebContentsView>[0]['port']
  const sessionRuntime = { acquire: vi.fn(), release: vi.fn() }
  const managed = createManagedWebContentsView({
    reconciler,
    viewId: 'host-dialog',
    marker: '--dimina-host-dialog',
    sessionRuntime,
    port,
    ...overrides,
  })
  return { managed, destroyView, sessionRuntime, attachments }
}

describe('createManagedWebContentsView: the channel follows the wc this manager owns', () => {
  it('a crash-and-rebuild releases the dead wc attachment and attaches the replacement', () => {
    const { managed, attachments } = makeOpts()
    managed.ensureView()
    const firstWc = created[created.length - 1]!
    expect(attachments).toHaveLength(1)

    firstWc._fireRenderProcessGone('crashed')
    expect(attachments[0]!.dispose).toHaveBeenCalledTimes(1)

    managed.ensureView()
    expect(attachments).toHaveLength(2)
    // Releasing the dead one must not touch the live one.
    expect(attachments[1]!.dispose).not.toHaveBeenCalled()
  })

  it('dispose() releases the current attachment', () => {
    const { managed, attachments } = makeOpts()
    managed.ensureView()

    managed.dispose()

    expect(attachments[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('a manager that never built a view has nothing to release', () => {
    const { managed, attachments } = makeOpts()
    managed.dispose()
    expect(attachments).toHaveLength(0)
  })
})

describe('createManagedWebContentsView: crash/failed-load recovery', () => {
  it('render-process-gone destroys the view and lets the next ensureView() build a fresh instance', () => {
    const { managed, destroyView } = makeOpts()
    const first = managed.ensureView()
    const firstWc = created[created.length - 1]!

    firstWc._fireRenderProcessGone('crashed')

    expect(destroyView).toHaveBeenCalledWith('host-dialog', first)
    expect(managed.liveWebContents()).toBeNull()

    const second = managed.ensureView()
    expect(second).not.toBe(first)
  })

  it('a main-frame did-fail-load with a real error code tears the view down', () => {
    const { managed, destroyView } = makeOpts()
    const first = managed.ensureView()
    const firstWc = created[created.length - 1]!

    firstWc._fireDidFailLoad(-6, true)

    expect(destroyView).toHaveBeenCalledWith('host-dialog', first)
    expect(managed.liveWebContents()).toBeNull()
  })

  it('ignores ERR_ABORTED (-3) — a fresh loadURL/loadFile superseding this one is routine, not a crash', () => {
    const { managed, destroyView } = makeOpts()
    managed.ensureView()
    const firstWc = created[created.length - 1]!

    firstWc._fireDidFailLoad(-3, true)

    expect(destroyView).not.toHaveBeenCalled()
    expect(managed.liveWebContents()).not.toBeNull()
  })

  it('ignores a did-fail-load on a subframe', () => {
    const { managed, destroyView } = makeOpts()
    managed.ensureView()
    const firstWc = created[created.length - 1]!

    firstWc._fireDidFailLoad(-6, false)

    expect(destroyView).not.toHaveBeenCalled()
    expect(managed.liveWebContents()).not.toBeNull()
  })

  it('a crash event on an already-superseded instance is a no-op (stale-instance guard)', () => {
    const { managed, destroyView } = makeOpts()
    managed.ensureView()
    const firstWc = created[created.length - 1]!
    // Supersede via dispose + a fresh ensureView, then fire the STALE first
    // instance's crash event.
    managed.dispose()
    const second = managed.ensureView()
    destroyView.mockClear()

    firstWc._fireRenderProcessGone('late crash')

    expect(destroyView).not.toHaveBeenCalled()
    expect(managed.liveWebContents()).toBe((second.webContents as unknown as WebContents))
  })

  it('invokes onBroken after tearing down — the on-demand overlay (host-dialog) needs this to withdraw its stale desired placement', () => {
    const onBroken = vi.fn()
    const { managed } = makeOpts({ onBroken })
    managed.ensureView()
    const firstWc = created[created.length - 1]!

    firstWc._fireRenderProcessGone('crashed')

    expect(onBroken).toHaveBeenCalledTimes(1)
  })

  it('does not require onBroken to be provided', () => {
    const { managed } = makeOpts()
    managed.ensureView()
    const firstWc = created[created.length - 1]!

    expect(() => firstWc._fireRenderProcessGone('crashed')).not.toThrow()
  })
})
