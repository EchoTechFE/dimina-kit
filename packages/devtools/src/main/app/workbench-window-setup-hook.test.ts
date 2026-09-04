/**
 * SETUP HOOK CONTRACT for `WorkbenchWindowManager.open()`.
 *
 * `deps.setupProjectWindow`, when provided, is awaited after
 * `setupEditorView()` finishes and before `open()` reports success. It
 * receives the window's OWN project context — never whatever context the
 * router currently considers active — so a host hook always configures the
 * window it was just told about, not some other open project.
 *
 * A rejection from the hook is not survivable the way `onBeforeClose`'s is:
 * there is no user-visible window left to run in yet, so `open()` must tear
 * the half-built window down (destroy the `BrowserWindow`, dispose its
 * context, drop it from `list()`) and reject with the hook's own error,
 * exactly like a `setupEditorView()` failure already does.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  stubs,
} from './window-close-reveal.harness.js'
import type { ProjectWindow } from './project-window.js'
import type { WorkbenchWindowDeps } from './workbench-window.js'

const editorStubs = vi.hoisted(() => ({
  contexts: [] as unknown[],
  created: [] as Array<{
    window: { isDestroyed: () => boolean }
    context: { registry: { add: (fn: () => void) => unknown } }
  }>,
  order: [] as string[],
}))

// Tracks every window the manager actually builds, so a rejected open can be
// proven to have torn its own window down — the assertion these tests exist
// to make.
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

vi.mock('./editor-view.js', () => ({
  setupEditorView: vi.fn(async (_config: unknown, context: unknown) => {
    editorStubs.contexts.push(context)
    editorStubs.order.push('editor')
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

async function buildManager(setupProjectWindow?: WorkbenchWindowDeps['setupProjectWindow']) {
  const [{ createWorkbenchWindowManager }, { createAppServices }, { createWindowContextRouter }, { rendererDir }] =
    await Promise.all([
      import('./workbench-window.js'),
      import('../services/app-services.js'),
      import('../services/window-contexts/context-router.js'),
      import('../utils/paths.js'),
    ])
  const onActiveContextChanged = vi.fn()
  const deps: WorkbenchWindowDeps = {
    config: {},
    rendererDir,
    appServices: createAppServices({}),
    router: createWindowContextRouter(),
    setupWindowModules: () => {},
    onActiveContextChanged,
    setupProjectWindow,
  }
  const manager = createWorkbenchWindowManager(deps)
  return { manager, onActiveContextChanged }
}

function registerProject(path: string): void {
  stubs.projectsWithAppJson.add(path)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
}

describe('workbench window manager setupProjectWindow hook', () => {
  it('awaits the hook after setupEditorView, and does not resolve open() until it settles', async () => {
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    editorStubs.order.length = 0
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    const setupProjectWindow = vi.fn(async () => {
      editorStubs.order.push('setup')
      await gate.promise
    })
    const { manager, onActiveContextChanged } = await buildManager(setupProjectWindow)
    registerProject('/tmp/setupHookPending')

    const openPromise = manager.open({ path: '/tmp/setupHookPending' })
    await vi.waitFor(() => {
      expect(setupProjectWindow).toHaveBeenCalledTimes(1)
    }, { timeout: 2000 })

    expect(editorStubs.order, 'setupEditorView must run before the hook').toEqual(['editor', 'setup'])
    expect(
      onActiveContextChanged,
      'open() must not announce a context change while the hook is still pending',
    ).not.toHaveBeenCalled()

    let resolved = false
    void openPromise.then(() => { resolved = true })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved, 'open() must not resolve while the hook is still pending').toBe(false)

    gate.resolve()
    await openPromise

    expect(resolved).toBe(true)
    expect(onActiveContextChanged).toHaveBeenCalled()
  })

  it('tears the window down and rejects with the hook\'s own error when it throws', async () => {
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    editorStubs.order.length = 0
    await state.createDevtoolsRuntime({})
    const failure = new Error('setup hook exploded')
    const setupProjectWindow = vi.fn(async () => { throw failure })
    const { manager, onActiveContextChanged } = await buildManager(setupProjectWindow)
    registerProject('/tmp/setupHookThrows')

    await expect(
      manager.open({ path: '/tmp/setupHookThrows' }),
      'open() must reject with the hook\'s own error, not a wrapped one',
    ).rejects.toBe(failure)

    expect(manager.list(), 'a window that failed setup must not remain listed').toHaveLength(0)
    expect(
      onActiveContextChanged,
      'a failed open must never announce a context change',
    ).not.toHaveBeenCalled()

    const built = editorStubs.created.at(-1)
    expect(built, 'the window under test must have been built before the hook ran').toBeDefined()
    expect(built!.window.isDestroyed(), 'the window must be destroyed on hook failure').toBe(true)
    expect(isDisposed(built!.context), 'the context must be disposed on hook failure').toBe(true)
  })

  it('passes the hook the window\'s own context, not another project\'s', async () => {
    editorStubs.contexts.length = 0
    editorStubs.created.length = 0
    editorStubs.order.length = 0
    await state.createDevtoolsRuntime({})
    const seen: unknown[] = []
    const setupProjectWindow = vi.fn(async (win: ProjectWindow) => { seen.push(win.context) })
    const { manager } = await buildManager(setupProjectWindow)
    registerProject('/tmp/setupHookCtxA')
    registerProject('/tmp/setupHookCtxB')

    await manager.open({ path: '/tmp/setupHookCtxA' })
    await manager.open({ path: '/tmp/setupHookCtxB' })

    expect(seen, 'the hook must run once per opened project').toHaveLength(2)
    expect(seen[0], 'project A\'s hook call must see project A\'s own context').toBe(editorStubs.contexts[0])
    expect(seen[1], 'project B\'s hook call must see project B\'s own context').toBe(editorStubs.contexts[1])
    expect(seen[0], 'the two projects must never share a context').not.toBe(seen[1])
  })
})
