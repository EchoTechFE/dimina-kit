/**
 * Contract: `WorkbenchWindowManager.open()` must resolve `project.path`
 * before using it as the window-identity key. The manager keys `windows` and
 * `pathQueues` by the raw string it receives (workbench-window.ts:135,141,
 * 157,171) — two spellings of the same directory ('/tmp/proj-a' vs.
 * '/tmp/proj-a/.') currently miss each other and open two windows over the
 * same project instead of focusing the existing one.
 *
 * Harness: same direct `createWorkbenchWindowManager` construction as the
 * third describe block in workbench-window-open-teardown.test.ts (the
 * "host close hook rejects" case), reusing its shared electron/devkit mock
 * set and stubs via window-close-reveal.harness.js.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  stubs,
} from './window-close-reveal.harness.js'

vi.mock('./editor-view.js', () => ({
  setupEditorView: vi.fn(async () => {}),
}))

const state = registerRuntimeTestLifecycle()

describe('WorkbenchWindowManager.open(): project.path identity is resolved, not compared as a raw string', () => {
  it('a second open() of the same directory under a differently-spelled path reuses the first window', async () => {
    await state.createDevtoolsRuntime({})

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
    })

    const canonicalPath = '/tmp/proj-a'
    // Deliberately NOT built with path.join/path.resolve — those normalize
    // away the trailing '/.' before the manager ever sees it, defeating the
    // point of this test (the manager itself must resolve, not its caller).
    const respelledPath = '/tmp/proj-a/.'
    stubs.projectsWithAppJson.add(canonicalPath)
    stubs.projectsWithAppJson.add(respelledPath)
    if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))

    const first = await manager.open({ path: canonicalPath })
    const second = await manager.open({ path: respelledPath })

    expect(
      manager.list(),
      'a differently-spelled path pointing at the SAME directory must not open a second window',
    ).toHaveLength(1)
    expect(second, 'the resolved second open must hand back the already-open window, not a fresh one').toBe(first)

    await manager.disposeAll()
  })
})
