/**
 * APP-READINESS GATE for `WorkbenchWindowManager.open()`.
 *
 * `deps.ready`, when provided, must resolve before `open()` builds a window.
 * `app.ts` registers the `OpenProjectWindow` IPC handler well before it
 * awaits the host's own `config.onSetup` hook, so a renderer that races
 * ahead can otherwise ask for a project window before the host has finished
 * wiring itself up. Omitting `ready` must not change behavior — most
 * managers never pass one.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  stubs,
} from './window-close-reveal.harness.js'
import type { WorkbenchWindowDeps } from './workbench-window.js'

const editorStubs = vi.hoisted(() => ({
  created: [] as Array<{ window: { isDestroyed: () => boolean } }>,
}))

// Tracks every window the manager actually builds, so "not built yet" can be
// asserted directly instead of inferred from timing.
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
  setupEditorView: vi.fn(async () => {}),
}))

const state = registerRuntimeTestLifecycle()

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

async function buildManager(ready?: Promise<void>) {
  const [{ createWorkbenchWindowManager }, { createAppServices }, { createWindowContextRouter }, { rendererDir }] =
    await Promise.all([
      import('./workbench-window.js'),
      import('../services/app-services.js'),
      import('../services/window-contexts/context-router.js'),
      import('../utils/paths.js'),
    ])
  const deps: WorkbenchWindowDeps = {
    config: {},
    rendererDir,
    appServices: createAppServices({}),
    router: createWindowContextRouter(),
    setupWindowModules: () => {},
    ready,
  }
  return createWorkbenchWindowManager(deps)
}

function registerProject(path: string): void {
  stubs.projectsWithAppJson.add(path)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
}

describe('workbench window manager app-readiness gate', () => {
  it('does not build a window while deps.ready is still pending', async () => {
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    const manager = await buildManager(gate.promise)
    registerProject('/tmp/readyGatePending')

    const openPromise = manager.open({ path: '/tmp/readyGatePending' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      editorStubs.created,
      'open() must not build a workbench window before deps.ready resolves',
    ).toHaveLength(0)

    gate.resolve()
    await openPromise

    expect(editorStubs.created, 'the window is built once deps.ready resolves').toHaveLength(1)
  })

  it('builds the window once deps.ready has already resolved', async () => {
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const manager = await buildManager(Promise.resolve())
    registerProject('/tmp/readyGateResolved')

    await manager.open({ path: '/tmp/readyGateResolved' })

    expect(editorStubs.created).toHaveLength(1)
  })

  it('builds the window immediately when deps.ready is not provided at all', async () => {
    editorStubs.created.length = 0
    await state.createDevtoolsRuntime({})
    const manager = await buildManager(undefined)
    registerProject('/tmp/readyGateOmitted')

    await manager.open({ path: '/tmp/readyGateOmitted' })

    expect(editorStubs.created).toHaveLength(1)
  })
})
