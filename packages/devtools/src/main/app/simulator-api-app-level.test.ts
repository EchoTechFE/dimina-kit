/**
 * SIMULATOR CUSTOM APIs ARE APP-LEVEL, NOT PER-WINDOW.
 *
 * `AppServices` owns the shared registrations. Each window's invocation
 * facade adds its own project context. A name registered once is visible to every
 * window, including windows opened later: the service host reads the
 * registered names off the registry when it spawns.
 *
 * The failure this guards: parking a registration's disposer on a WINDOW's
 * registry. Closing that window then deletes the handler from the shared map,
 * and every other open window loses `wx.<name>()` — including the built-in
 * `login`. A registration may only be revoked by the host disposing it.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  openProjectWindow,
  makeCloseEvent,
  emitClose,
} from './window-close-reveal.harness.js'

const state = registerRuntimeTestLifecycle()

describe('simulator custom API lifetime across project windows', () => {
  it('dispatches each window with its own project even when another window is focused', async () => {
    const instance = await state.createDevtoolsRuntime({})
    instance.registerSimulatorApi('projectIdentity', async (_params, context) => context?.projectPath)
    const first = await openProjectWindow(instance, '/tmp/simApiIdentityA')
    const second = await openProjectWindow(instance, '/tmp/simApiIdentityB')
    await first.context.workspace.openProject('/tmp/simApiIdentityA')
    await second.context.workspace.openProject('/tmp/simApiIdentityB')

    expect(instance.context.workspace.hasActiveSession()).toBe(false)
    second.window.emit('focus')
    await expect(Promise.all([
      first.context.simulatorApis.invoke('projectIdentity', { projectPath: '/forged' }),
      second.context.simulatorApis.invoke('projectIdentity', {}),
    ])).resolves.toEqual(['/tmp/simApiIdentityA', '/tmp/simApiIdentityB'])

    await instance.dispose()
  })

  it('keeps host APIs working in the windows that stay open when one window closes', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const first = await openProjectWindow(instance, '/tmp/simApiA1')
    const second = await openProjectWindow(instance, '/tmp/simApiA2')

    instance.registerSimulatorApi('hostEcho', async (params) => params)

    // Wait for the window to be DESTROYED, not merely for the manager's list
    // to shrink: destruction is the last step of teardown, so it is the only
    // point at which the closing window's registry is guaranteed to have run.
    emitClose(first.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(first.window.isDestroyed()).toBe(true)
    }, { timeout: 2000 })

    expect(
      second.context.simulatorApis.has('hostEcho'),
      'closing one project window must not revoke a host API from the windows still open',
    ).toBe(true)
    await expect(second.context.simulatorApis.invoke('hostEcho', 42)).resolves.toBe(42)
    expect(
      second.context.simulatorApis.has('login'),
      'the built-in login API travels the same path and must survive a window close too',
    ).toBe(true)

    await instance.dispose()
  })

  it('exposes an API registered before any window opened to a window opened after', async () => {
    const instance = await state.createDevtoolsRuntime({})
    instance.registerSimulatorApi('hostLate', async () => 'late')

    const projectWindow = await openProjectWindow(instance, '/tmp/simApiB')

    expect(
      projectWindow.context.simulatorApis.has('hostLate'),
      'a window opened later reads the same app-level registry — no replay needed',
    ).toBe(true)
    await expect(projectWindow.context.simulatorApis.invoke('hostLate', null)).resolves.toBe('late')

    await instance.dispose()
  })

  it('revokes an API everywhere when the host disposes its registration', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const projectWindow = await openProjectWindow(instance, '/tmp/simApiC')

    const registration = instance.registerSimulatorApi('hostRevocable', async () => 'ok')
    expect(projectWindow.context.simulatorApis.has('hostRevocable')).toBe(true)

    await registration.dispose()

    expect(
      projectWindow.context.simulatorApis.has('hostRevocable'),
      'the host disposing its registration is the ONLY thing that revokes an API',
    ).toBe(false)

    await instance.dispose()
  })
})
