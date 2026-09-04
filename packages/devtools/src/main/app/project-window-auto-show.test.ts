/**
 * PROJECT-WINDOW VISIBILITY CONTRACT.
 *
 * A project window is now ALWAYS created hidden (`autoShow: false` into
 * `createMainWindow`) — `workbench-window.ts`'s reveal gate is the only thing
 * that ever shows it, once `setupProjectWindow` has resolved AND the
 * renderer's own `ready-to-show` has fired. `config.projectWindow.autoShow`
 * no longer reaches `createMainWindow` at all; the reveal gate reads it
 * instead (see `workbench-window-show-after-setup-hook.test.ts`).
 *
 * The project-LIST window is unaffected: `config.window.autoShow` still goes
 * straight into `createMainWindow` for `createLauncherWindow`, independent of
 * anything under `config.projectWindow`.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerRuntimeTestLifecycle } from './window-close-reveal.harness.js'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import type { CreateProjectWindowOptions } from './project-window.js'

const createMainWindowSpy = vi.hoisted(() => vi.fn())

vi.mock('../windows/main-window/create.js', async () => {
  const actual =
    await vi.importActual<typeof import('../windows/main-window/create.js')>('../windows/main-window/create.js')
  return {
    ...actual,
    createMainWindow: (opts: Parameters<typeof actual.createMainWindow>[0]) => {
      createMainWindowSpy(opts)
      return actual.createMainWindow(opts)
    },
  }
})

const state = registerRuntimeTestLifecycle()

async function buildOptions(): Promise<Omit<CreateProjectWindowOptions, 'config'>> {
  const [{ createAppServices }, { createWindowContextRouter }, { rendererDir }] = await Promise.all([
    import('../services/app-services.js'),
    import('../services/window-contexts/context-router.js'),
    import('../utils/paths.js'),
  ])
  return { appServices: createAppServices({}), router: createWindowContextRouter(), rendererDir }
}

/** The `autoShow` the most recent `createMainWindow` call was given. */
function lastAutoShow(): boolean | undefined {
  const call = createMainWindowSpy.mock.calls.at(-1) as [{ autoShow?: boolean }] | undefined
  return call?.[0].autoShow
}

describe('project window autoShow visibility', () => {
  it.each([
    ['no projectWindow config', {} as WorkbenchAppConfig],
    ['projectWindow.autoShow: true', { projectWindow: { autoShow: true } } as WorkbenchAppConfig],
    ['projectWindow.autoShow: false', { projectWindow: { autoShow: false } } as WorkbenchAppConfig],
    ['window.autoShow: false (list-window opt-out)', { window: { autoShow: false } } as WorkbenchAppConfig],
  ])('creates the project window hidden regardless of config (%s)', async (_label, config) => {
    await state.createDevtoolsRuntime({})
    createMainWindowSpy.mockClear()
    const { createWorkbenchWindow } = await import('./project-window.js')
    const opts = await buildOptions()

    createWorkbenchWindow({ config, ...opts }, { path: '/tmp/autoShowAlwaysHidden' })

    expect(
      lastAutoShow(),
      'a project window must always be created hidden — the reveal gate in workbench-window.ts shows it, not createMainWindow',
    ).toBe(false)
  })

  it('the list window keeps tracking config.window.autoShow, unaffected by projectWindow', async () => {
    await state.createDevtoolsRuntime({})
    createMainWindowSpy.mockClear()
    const { createLauncherWindow } = await import('./project-window.js')
    const opts = await buildOptions()
    const config: WorkbenchAppConfig = { projectWindow: { autoShow: false }, window: { autoShow: false } }

    createLauncherWindow({ config, ...opts })

    expect(lastAutoShow(), 'the list window must keep tracking its own config.window.autoShow').toBe(false)
  })
})
