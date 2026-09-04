/**
 * PROJECT-WINDOW VISIBILITY CONTRACT.
 *
 * `config.window.autoShow` and `config.projectWindow.autoShow` are two
 * independent knobs: the former governs the project-LIST window
 * (`createLauncherWindow`), the latter governs a single opened project's own
 * window (`createWorkbenchWindow`). Before this contract both windows read
 * the same `config.window?.autoShow` — a host hiding the list window (e.g.
 * a login gate) also hid every project window it opened, with no way for
 * the host to tell the two apart.
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
  it('does not inherit config.window.autoShow:false for the project window', async () => {
    await state.createDevtoolsRuntime({})
    createMainWindowSpy.mockClear()
    const { createWorkbenchWindow } = await import('./project-window.js')
    const opts = await buildOptions()
    const config: WorkbenchAppConfig = { window: { autoShow: false } }

    createWorkbenchWindow({ config, ...opts }, { path: '/tmp/autoShowDefault' })

    expect(
      lastAutoShow(),
      'a project window with no projectWindow config must stay visible even when the list window opts out',
    ).not.toBe(false)
  })

  it('hides only the project window when config.projectWindow.autoShow is false', async () => {
    await state.createDevtoolsRuntime({})
    createMainWindowSpy.mockClear()
    const { createWorkbenchWindow, createLauncherWindow } = await import('./project-window.js')
    const opts = await buildOptions()
    const config: WorkbenchAppConfig = { projectWindow: { autoShow: false } }

    createWorkbenchWindow({ config, ...opts }, { path: '/tmp/autoShowProjectOnly' })
    expect(lastAutoShow(), 'the project window must honor config.projectWindow.autoShow').toBe(false)

    createLauncherWindow({ config, ...opts })
    expect(
      lastAutoShow(),
      'the list window must keep tracking config.window.autoShow, unaffected by projectWindow',
    ).toBeUndefined()
  })
})
