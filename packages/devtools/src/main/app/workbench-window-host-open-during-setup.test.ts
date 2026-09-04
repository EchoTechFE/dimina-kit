/**
 * `deps.ready` gates every `open()` so a renderer racing ahead of the host's
 * own `config.onSetup` never gets a window the host hasn't finished
 * extending — see `workbench-window.ts`'s `ready` doc comment. But `ready`
 * itself resolves only once `onSetup` settles (`app.ts`'s `markReady(setup)`),
 * so a host that calls `instance.openProjectWindow()` FROM WITHIN its own
 * `onSetup` deadlocks: `open()` awaits `ready`, and `ready` awaits the very
 * `onSetup` call that is awaiting `open()`.
 *
 * The fix under test: `open()` takes a second, optional
 * `{ awaitReady?: boolean }` argument. `awaitReady: false` lets the caller
 * skip the readiness gate — the host uses it for its own
 * `instance.openProjectWindow` calls, never for the renderer-facing IPC path,
 * which must keep parking on `ready` exactly as today.
 */
import { describe, it, expect } from 'vitest'
import { registerRuntimeTestLifecycle, stubs } from './window-close-reveal.harness.js'
import type { WorkbenchWindowDeps, WorkbenchWindowManager } from './workbench-window.js'
import type { ProjectRef } from './project-window.js'

const state = registerRuntimeTestLifecycle()

function registerProject(path: string): void {
  stubs.projectsWithAppJson.add(path)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
}

async function buildManager(ready: Promise<void>): Promise<WorkbenchWindowManager> {
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

/**
 * Calls `open` with the not-yet-typed `awaitReady` option. The option is
 * cast in, not typed on `WorkbenchWindowManager['open']`, so this helper is
 * the one place a future signature change has to touch.
 */
function openWithOptions(
  manager: WorkbenchWindowManager,
  project: ProjectRef,
  options: { awaitReady?: boolean },
): Promise<unknown> {
  return (manager.open as unknown as (p: ProjectRef, o?: { awaitReady?: boolean }) => Promise<unknown>)(
    project,
    options,
  )
}

/** True if `p` has not settled after `ms` — never used to await a real resolution, only to prove one hasn't happened yet. */
function isStillPendingAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol('pending')
  return Promise.race([
    p.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]).then((result) => result === pending)
}

describe('workbench window open during a pending host onSetup', () => {
  it('open(project, { awaitReady: false }) resolves while deps.ready never settles', async () => {
    await state.createDevtoolsRuntime({})
    const neverReady = new Promise<void>(() => {})
    const manager = await buildManager(neverReady)
    registerProject('/tmp/awaitReadyFalseResolves')

    const opened = await Promise.race([
      openWithOptions(manager, { path: '/tmp/awaitReadyFalseResolves' }, { awaitReady: false }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('open(project, { awaitReady: false }) did not resolve within 2000ms even though deps.ready never settles')),
        2000,
      )),
    ])

    expect(opened, 'open() must still hand back the opened window').toBeDefined()
  })

  it('open(project) with no options keeps parking on deps.ready, unlike awaitReady:false', async () => {
    await state.createDevtoolsRuntime({})
    const neverReady = new Promise<void>(() => {})
    const manager = await buildManager(neverReady)
    registerProject('/tmp/awaitReadyDefaultParks')

    const stillPending = await isStillPendingAfter(
      manager.open({ path: '/tmp/awaitReadyDefaultParks' }),
      250,
    )

    expect(stillPending, 'open() with no options must remain parked behind an unsettled deps.ready').toBe(true)
  })
})

describe('app.ts: a host onSetup that opens its own project window', () => {
  it('createDevtoolsRuntime settles even when onSetup awaits instance.openProjectWindow for a project it opens itself', async () => {
    registerProject('/tmp/onSetupOpensOwnWindow')

    const booted = await Promise.race([
      state.createDevtoolsRuntime({
        // `onSetup`'s declared param type (`WorkbenchHostInstance`) omits
        // `openProjectWindow` — it is a runtime-only member of the fuller
        // `WorkbenchAppInstance` this hook actually receives.
        onSetup: async (instance) => {
          await (instance as unknown as { openProjectWindow: (p: ProjectRef) => Promise<unknown> })
            .openProjectWindow({ path: '/tmp/onSetupOpensOwnWindow' })
        },
      }).then((instance) => ({ settled: true as const, instance })),
      new Promise<{ settled: false }>((resolve) => setTimeout(
        () => resolve({ settled: false }),
        2000,
      )),
    ])

    expect(
      booted.settled,
      'instance.openProjectWindow awaited inside onSetup must not deadlock app boot (open() awaits ready, ready awaits onSetup)',
    ).toBe(true)
    if (booted.settled) {
      expect(booted.instance.projectWindows()).toHaveLength(1)
    }
  }, 4000)
})
