/**
 * TERMINATION SEMANTICS for `WorkbenchWindowManager.disposeAll()`.
 *
 * `disposeAll()` currently only snapshots and clears the `windows` map; it
 * does not set any terminal state and does not touch `pathQueues`. That
 * leaves two gaps:
 *
 * 1. An `open()` arriving after `disposeAll()` — directly, or dequeued later
 *    from behind a close that was already queued on the same path — finds an
 *    empty map and happily builds a brand new window, resurrecting a project
 *    the app just tore down.
 * 2. An `open()` already past the map insertion and awaiting
 *    `setupEditorView()` when `disposeAll()` runs gets its window disposed
 *    and destroyed out from under it. `disposeAll()` does not wait for this
 *    in-flight open, so it can return before that race even resolves. The
 *    open then resumes, finds nothing wrong, and hands the caller an
 *    already-destroyed `BrowserWindow` while firing `onActiveContextChanged`
 *    for a window nothing can reach any more.
 *
 * These tests pin the contract: once `disposeAll()` starts, no `open()` —
 * pending, queued, or in-flight — produces a live window, and `disposeAll()`
 * does not return until every in-flight open has settled.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  makeCloseEvent,
  emitClose,
  stubs,
} from './window-close-reveal.harness.js'

const editorStubs = vi.hoisted(() => ({
  gate: null as null | { promise: Promise<void>; resolve: () => void },
  contexts: [] as unknown[],
  created: [] as Array<{ window: { isDestroyed: () => boolean } }>,
}))

// Tracks every window the manager actually builds, so a rejected open can be
// proven to have never built one — the assertion these tests exist to make.
vi.mock('./project-window.js', async () => {
  const actual = await vi.importActual<typeof import('./project-window.js')>('./project-window.js')
  return {
    ...actual,
    createWorkbenchWindow: (...args: Parameters<typeof actual.createWorkbenchWindow>) => {
      const projectWindow = actual.createWorkbenchWindow(...args)
      editorStubs.created.push(projectWindow)
      return projectWindow
    },
  }
})

// The last awaited step of `open()`, and a controllable pause point: with a
// gate installed, setupEditorView parks here until the test releases it,
// which is what lets a test land `disposeAll()` mid-open.
vi.mock('./editor-view.js', () => ({
  setupEditorView: vi.fn(async (_config: unknown, context: unknown) => {
    editorStubs.contexts.push(context)
    if (editorStubs.gate) await editorStubs.gate.promise
  }),
}))

const state = registerRuntimeTestLifecycle()

interface DisposalProbe {
  registry: { add: (fn: () => void) => unknown }
}

/** A context is disposed exactly when its registry refuses new entries. */
function isDisposed(ctx: DisposalProbe): boolean {
  try {
    ctx.registry.add(() => {})
    return false
  } catch {
    return true
  }
}

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

async function buildManager(onBeforeClose?: () => Promise<void>) {
  const [{ createWorkbenchWindowManager }, { createAppServices }, { createWindowContextRouter }, { rendererDir }] =
    await Promise.all([
      import('./workbench-window.js'),
      import('../services/app-services.js'),
      import('../services/window-contexts/context-router.js'),
      import('../utils/paths.js'),
    ])
  const onActiveContextChanged = vi.fn()
  const manager = createWorkbenchWindowManager({
    config: {},
    rendererDir,
    appServices: createAppServices({}),
    router: createWindowContextRouter(),
    setupWindowModules: () => {},
    onActiveContextChanged,
    onBeforeClose: onBeforeClose ?? (async () => {}),
  })
  return { manager, onActiveContextChanged }
}

function registerProject(path: string): void {
  stubs.projectsWithAppJson.add(path)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
}

describe('workbench window manager disposeAll termination', () => {
  it('rejects any open() requested after disposeAll(), without building a window', async () => {
    editorStubs.gate = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const { manager } = await buildManager()
    registerProject('/tmp/afterDispose')

    await manager.disposeAll()

    await expect(
      manager.open({ path: '/tmp/afterDispose' }),
      'a manager that already tore everything down must not resurrect a project window',
    ).rejects.toThrow(/disposed/)

    expect(
      editorStubs.created,
      'the rejection must happen before any window is built',
    ).toHaveLength(0)
    expect(manager.list()).toHaveLength(0)
  })

  it('rejects an open() that was queued behind an in-flight close when disposeAll() runs', async () => {
    editorStubs.gate = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const closeGate = createGate()
    const { manager } = await buildManager(async () => { await closeGate.promise })
    registerProject('/tmp/queuedOpen')

    const window1 = await manager.open({ path: '/tmp/queuedOpen' })
    expect(manager.list()).toHaveLength(1)

    // Starts the close's teardown, which parks on the onBeforeClose gate and
    // occupies this path's queue.
    emitClose(window1, makeCloseEvent().event)

    // Queued behind the still-pending close.
    const secondOpen = manager.open({ path: '/tmp/queuedOpen' })

    const disposeAllPromise = manager.disposeAll()
    closeGate.resolve()

    await expect(
      secondOpen,
      'an open dequeued after disposeAll() started must not build a second window',
    ).rejects.toThrow(/disposed/)
    await disposeAllPromise

    expect(manager.list()).toHaveLength(0)
    expect(
      editorStubs.created,
      'only the first, already-closing window should ever have been built',
    ).toHaveLength(1)
  })

  it('waits for an open() stuck in setupEditorView, which tears itself down and rejects', async () => {
    editorStubs.gate = createGate()
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const { manager, onActiveContextChanged } = await buildManager()
    registerProject('/tmp/inFlightOpen')

    const openPromise = manager.open({ path: '/tmp/inFlightOpen' })
    await vi.waitFor(() => {
      expect(editorStubs.contexts).toHaveLength(1)
    }, { timeout: 2000 })

    const callsBeforeDispose = onActiveContextChanged.mock.calls.length
    let disposeAllSettled = false
    const disposeAllPromise = manager.disposeAll().then(() => { disposeAllSettled = true })

    // Give the pending gate a few microtask turns: disposeAll() must not
    // resolve while the open it needs to wait for is still stuck.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(
      disposeAllSettled,
      'disposeAll() must wait for the in-flight open to settle, not race past it',
    ).toBe(false)

    editorStubs.gate.resolve()

    await expect(
      openPromise,
      'an open racing disposeAll() must reject instead of handing back a destroyed window',
    ).rejects.toThrow(/disposed/)
    await disposeAllPromise

    expect(disposeAllSettled).toBe(true)
    expect(manager.list()).toHaveLength(0)

    const ctx = editorStubs.contexts.at(0) as DisposalProbe
    expect(
      isDisposed(ctx),
      'the open must clean up the half-built context itself once it discovers it lost the race',
    ).toBe(true)
    expect(
      editorStubs.created.at(0)?.window.isDestroyed(),
      'the window built by the losing open must not be left on screen',
    ).toBe(true)
    expect(
      onActiveContextChanged.mock.calls.length,
      'a losing open must not announce itself as the active context',
    ).toBe(callsBeforeDispose)
  })

  it('is idempotent: a second call does not throw or re-dispose the same window', async () => {
    editorStubs.gate = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const { manager } = await buildManager()
    registerProject('/tmp/idempotentDispose')

    await manager.open({ path: '/tmp/idempotentDispose' })
    expect(manager.list()).toHaveLength(1)

    await manager.disposeAll()
    expect(manager.list()).toHaveLength(0)

    await expect(
      manager.disposeAll(),
      'a repeated disposeAll() must resolve cleanly, not throw on an already-torn-down state',
    ).resolves.toBeUndefined()
    expect(manager.list()).toHaveLength(0)

    await expect(
      manager.open({ path: '/tmp/idempotentDispose' }),
      'the terminal state set by the first disposeAll() must still hold after a second call',
    ).rejects.toThrow(/disposed/)
  })
})
