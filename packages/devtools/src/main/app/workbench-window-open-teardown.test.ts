/**
 * PARTIAL-OPEN AND HOOK-FAILURE TEARDOWN for workbench windows.
 *
 * Two failures that leave a window the app can no longer clean up:
 *
 * 1. `open()` rejects halfway (the editor's COI http server can fail on a
 *    taken port or exhausted fds). The window, its context and its runtime
 *    services already exist by then. Leaving them behind gives the user a
 *    window whose close disposes nothing, and leaves a phantom entry in the
 *    manager's map — which is what the list window consults to decide whether
 *    to hide itself, so it hides behind a project that is not there.
 * 2. The host's `onBeforeClose` hook rejects. Host code cannot be allowed to
 *    veto OUR cleanup: the compile session, bridge router, editor server and
 *    IPC registrations must go regardless.
 *
 * Both invariants are the same one: whatever happens, a workbench window
 * leaves no live resources and no map entry behind.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  makeCloseEvent,
  emitClose,
  stubs,
} from './window-close-reveal.harness.js'

const editorStubs = vi.hoisted(() => ({
  failWith: null as Error | null,
  contexts: [] as unknown[],
  created: [] as Array<{ window: { isDestroyed: () => boolean } }>,
}))

// Records every workbench window the manager builds, so a window abandoned by
// a failed open can still be inspected — the manager's own list is exactly
// what such a window must NOT appear in.
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

// The editor assembly is the last awaited step of `open()` and the realistic
// place for a partial-open failure, so it is the seam this file drives.
vi.mock('./editor-view.js', () => ({
  setupEditorView: vi.fn(async (_config: unknown, context: unknown) => {
    editorStubs.contexts.push(context)
    if (editorStubs.failWith) throw editorStubs.failWith
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

describe('workbench window whose initialization fails partway', () => {
  it('leaves no window, no context and no map entry behind, and reports the failure', async () => {
    editorStubs.failWith = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    const instance = await state.createDevtoolsRuntime({})

    stubs.projectsWithAppJson.add('/tmp/partialOpen')
    if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
    editorStubs.failWith = new Error('COI server failed to bind')

    await expect(
      instance.openProjectWindow({ path: '/tmp/partialOpen' }),
      'a failed initialization must reach the caller, not resolve with a broken window',
    ).rejects.toThrow('COI server failed to bind')

    expect(
      instance.projectWindows(),
      'a window that never finished opening must not count as an open project — the list window hides itself based on this',
    ).toHaveLength(0)

    const ctx = editorStubs.contexts.at(-1) as DisposalProbe
    expect(ctx, 'setup: the failing open must have reached the editor step').toBeTruthy()
    expect(
      isDisposed(ctx),
      'the half-built context owns runtime services and IPC registrations — the failure path must dispose it',
    ).toBe(true)
    expect(
      editorStubs.created.at(-1)?.window.isDestroyed(),
      'an orphan window with no working close handling must not be left on screen',
    ).toBe(true)

    editorStubs.failWith = null
    await instance.dispose()
  })

  it('lets the same project be opened again after a failed attempt', async () => {
    editorStubs.failWith = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    const instance = await state.createDevtoolsRuntime({})

    stubs.projectsWithAppJson.add('/tmp/partialOpenRetry')
    if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
    editorStubs.failWith = new Error('COI server failed to bind')
    await expect(instance.openProjectWindow({ path: '/tmp/partialOpenRetry' })).rejects.toThrow()

    editorStubs.failWith = null
    await instance.openProjectWindow({ path: '/tmp/partialOpenRetry' })

    expect(
      instance.projectWindows(),
      'the failed attempt must not leave a stale entry that swallows the retry',
    ).toHaveLength(1)

    await instance.dispose()
  })
})

describe('workbench window teardown when the host close hook rejects', () => {
  it('disposes the window context anyway', async () => {
    editorStubs.failWith = null
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0

    const [{ createWorkbenchWindowManager }, { createAppServices }, { createWindowContextRouter }, { rendererDir }] =
      await Promise.all([
        import('./workbench-window.js'),
        import('../services/app-services.js'),
        import('../services/window-contexts/context-router.js'),
        import('../utils/paths.js'),
      ])

    const manager = createWorkbenchWindowManager({
      config: {},
      rendererDir,
      appServices: createAppServices({}),
      router: createWindowContextRouter(),
      setupWindowModules: () => {},
      onBeforeClose: async () => {
        throw new Error('host onBeforeClose rejected')
      },
    })

    stubs.projectsWithAppJson.add('/tmp/hookRejects')
    if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
    const window = await manager.open({ path: '/tmp/hookRejects' })
    const projectWindow = manager.list()[0]!
    const ctx = projectWindow.context as unknown as DisposalProbe

    emitClose(window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(window.isDestroyed()).toBe(true)
    }, { timeout: 2000 })

    expect(
      isDisposed(ctx),
      'a rejecting host hook must not strand the compile session, bridge and editor server',
    ).toBe(true)
    expect(
      manager.list(),
      'the window is gone, so it must not still count as an open project',
    ).toHaveLength(0)

    await manager.disposeAll()
  })
})
