/**
 * PROJECT-WINDOW REVEAL CONTRACT.
 *
 * A project window is created hidden and must stay hidden until BOTH of
 * these have happened, in either order:
 *
 *  - its `setupProjectWindow` hook has resolved (a hook that fails leaves
 *    nothing worth showing — see `workbench-window-setup-hook.test.ts`), and
 *  - the window's own `ready-to-show` has fired (Chromium's signal that the
 *    first frame is paintable).
 *
 * Today `createConfiguredMainWindow` passes `config.projectWindow?.autoShow
 * ?? true` straight into `createMainWindow`, which shows the window on
 * `ready-to-show` alone — the hook's progress never enters into it. A hook
 * that is still running (or about to throw) loses the race: the window
 * flashes on screen and, on failure, is destroyed a moment later.
 *
 * `config.projectWindow.autoShow === false` is a separate, permanent opt-out:
 * the framework must never show that window on its own, no matter what the
 * hook does or how many times `ready-to-show` fires.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerRuntimeTestLifecycle, stubs, makeCloseEvent, emitClose } from './window-close-reveal.harness.js'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import type { WorkbenchWindowDeps } from './workbench-window.js'

const state = registerRuntimeTestLifecycle()

function registerProject(path: string): void {
  stubs.projectsWithAppJson.add(path)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
}

function createGate(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface MockWindow {
  emit: (event: string, ...args: unknown[]) => void
  show: { mock: { calls: unknown[][] } }
  showInactive: { mock: { calls: unknown[][] } }
}

/** Every call this test can observe the manager making to reveal the window. */
function revealCallCount(win: MockWindow): number {
  return win.show.mock.calls.length + win.showInactive.mock.calls.length
}

async function buildManager(
  config: WorkbenchAppConfig,
  setupProjectWindow: WorkbenchWindowDeps['setupProjectWindow'],
  extraDeps?: Partial<WorkbenchWindowDeps>,
) {
  const [{ createWorkbenchWindowManager }, { createAppServices }, { createWindowContextRouter }, { rendererDir }] =
    await Promise.all([
      import('./workbench-window.js'),
      import('../services/app-services.js'),
      import('../services/window-contexts/context-router.js'),
      import('../utils/paths.js'),
    ])
  const deps: WorkbenchWindowDeps = {
    config,
    rendererDir,
    appServices: createAppServices({}),
    router: createWindowContextRouter(),
    setupWindowModules: () => {},
    setupProjectWindow,
    ...extraDeps,
  }
  return createWorkbenchWindowManager(deps)
}

describe('project window reveal waits on both the setup hook and ready-to-show', () => {
  it('ready-to-show before the hook resolves must not reveal the window; the hook resolving does, exactly once', async () => {
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    const manager = await buildManager({}, async () => { await gate.promise })
    registerProject('/tmp/showAfterHookPending')

    const openPromise = manager.open({ path: '/tmp/showAfterHookPending' })
    await vi.waitFor(() => {
      expect(manager.list()).toHaveLength(1)
    })
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')
    expect(
      revealCallCount(win),
      'ready-to-show firing before the hook resolves must not reveal the window',
    ).toBe(0)

    gate.resolve()
    await openPromise

    expect(
      revealCallCount(win),
      'the window must be revealed exactly once, after the hook resolves',
    ).toBe(1)
  })

  it('a rejecting hook must never reveal the window, even after ready-to-show fired', async () => {
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    const failure = new Error('setup hook exploded')
    const manager = await buildManager({}, async () => { await gate.promise })
    registerProject('/tmp/showAfterHookRejects')

    const openPromise = manager.open({ path: '/tmp/showAfterHookRejects' })
    await vi.waitFor(() => {
      expect(manager.list()).toHaveLength(1)
    })
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')
    gate.reject(failure)

    await expect(openPromise, 'open() must reject with the hook\'s own error').rejects.toBe(failure)
    expect(
      revealCallCount(win),
      'a window whose hook failed must never be revealed, ready-to-show or not',
    ).toBe(0)
  })

  it('a hook that resolves before ready-to-show only reveals once ready-to-show fires, and open() does not wait for the reveal', async () => {
    await state.createDevtoolsRuntime({})
    const manager = await buildManager({}, async () => {})
    registerProject('/tmp/showAfterReadyToShowLate')

    const openPromise = manager.open({ path: '/tmp/showAfterReadyToShowLate' })
    await openPromise
    const win = manager.list()[0]!.window as unknown as MockWindow

    expect(
      revealCallCount(win),
      'open() resolving (hook already settled) must not by itself reveal the window',
    ).toBe(0)

    win.emit('ready-to-show')
    expect(revealCallCount(win), 'ready-to-show after the hook must reveal the window').toBe(1)
  })

  it('config.projectWindow.autoShow === false keeps the window hidden no matter what the hook or ready-to-show do', async () => {
    await state.createDevtoolsRuntime({})
    const config: WorkbenchAppConfig = { projectWindow: { autoShow: false } }
    const manager = await buildManager(config, async () => {})
    registerProject('/tmp/showAfterAutoShowFalse')

    const openPromise = manager.open({ path: '/tmp/showAfterAutoShowFalse' })
    await openPromise
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')
    expect(
      revealCallCount(win),
      'projectWindow.autoShow: false must permanently opt the window out of the framework\'s own reveal',
    ).toBe(0)
  })
})

describe('a close or teardown that lands while the setup hook is pending must win the race', () => {
  it('a window closed while the hook is still pending must never be revealed once the hook resolves', async () => {
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    let hookEntered = false
    const manager = await buildManager({}, async () => {
      hookEntered = true
      await gate.promise
    })
    registerProject('/tmp/closeDuringSetupHook')

    const openPromise = manager.open({ path: '/tmp/closeDuringSetupHook' })
    await vi.waitFor(() => {
      expect(hookEntered).toBe(true)
    })
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')

    // The window is asked to close while setupProjectWindow is still pending;
    // teardown queues behind the still-running open on the same project path.
    emitClose(win, makeCloseEvent().event)

    gate.resolve()
    await openPromise

    expect(
      revealCallCount(win),
      'a window whose close was already requested must not be revealed just because the hook later resolved',
    ).toBe(0)

    await vi.waitFor(() => {
      expect(manager.list()).toHaveLength(0)
    })
  })

  it('a manager torn down by disposeAll while the hook is pending must never reveal the window', async () => {
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    let hookEntered = false
    const manager = await buildManager({}, async () => {
      hookEntered = true
      await gate.promise
    })
    registerProject('/tmp/disposeAllDuringSetupHook')

    const openPromise = manager.open({ path: '/tmp/disposeAllDuringSetupHook' })
    await vi.waitFor(() => {
      expect(hookEntered).toBe(true)
    })
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')

    const disposeAllPromise = manager.disposeAll()
    gate.resolve()

    await expect(
      openPromise,
      'an open whose hook resolved after disposeAll() began must reject, not hand back a window about to be destroyed',
    ).rejects.toThrow(/disposed/)
    await disposeAllPromise

    expect(
      revealCallCount(win),
      'a window whose manager already started disposeAll() must not be revealed once the hook resolves',
    ).toBe(0)
  })

  it('teardown queued behind an open that disposeAll already tore down must not run onBeforeClose again', async () => {
    await state.createDevtoolsRuntime({})
    const gate = createGate()
    let hookEntered = false
    const onBeforeClose = vi.fn(async () => {})
    const manager = await buildManager(
      {},
      async () => {
        hookEntered = true
        await gate.promise
      },
      { onBeforeClose },
    )
    registerProject('/tmp/teardownAfterDisposeAllRace')

    const openPromise = manager.open({ path: '/tmp/teardownAfterDisposeAllRace' })
    await vi.waitFor(() => {
      expect(hookEntered).toBe(true)
    })
    const win = manager.list()[0]!.window as unknown as MockWindow

    win.emit('ready-to-show')

    // Close is requested first, so its teardown queues behind this still-running
    // open on the same project path (see `enqueue`); disposeAll() then begins
    // while both are still queued.
    emitClose(win, makeCloseEvent().event)
    const disposeAllPromise = manager.disposeAll()
    gate.resolve()

    await expect(
      openPromise,
      'an open whose hook resolved after disposeAll() began must reject',
    ).rejects.toThrow(/disposed/)
    await disposeAllPromise
    await vi.waitFor(() => {
      expect(manager.list()).toHaveLength(0)
    })

    expect(
      onBeforeClose,
      'the queued teardown finds its window already torn down by the failed open and must not hand ' +
        'a destroyed window to onBeforeClose a second time',
    ).not.toHaveBeenCalled()
    expect(revealCallCount(win)).toBe(0)
    expect(manager.list()).toHaveLength(0)
  })
})
