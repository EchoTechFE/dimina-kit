/**
 * A simulator UI extension belongs to the project windows, and `invoke` reaches
 * the project window the user is working in.
 *
 * Two failures this guards:
 *
 * 1. The project list is not a simulator surface — it runs no bridge router, no
 *    service host and no device frame. Registering an extension into it gives
 *    `invoke` a target that can never mount anything, and whenever the list
 *    window is the app-active one that dead target is what `invoke` picks.
 * 2. A target record outlives its window. The record is created when a window
 *    opens; if nothing removes it when that window is torn down, `invoke`
 *    reaches an extension that was already disposed with the window, and the
 *    ledger grows with every project window ever opened.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SimulatorUiExtensionHandle } from '../../shared/simulator-ui.js'
import {
  registerRuntimeTestLifecycle,
  openProjectWindow,
  makeCloseEvent,
  emitClose,
} from './window-close-reveal.harness.js'

const state = registerRuntimeTestLifecycle()

const REGISTRATION = { id: 'host.panel', rendererScriptPath: '/tmp/host-panel.js' }

/**
 * Replace one window's extension registry with a recorder, so "which window
 * did this invoke reach" is observable without a live simulator renderer.
 */
function recordExtensionsOf(context: unknown, label: string) {
  const calls: string[] = []
  let disposed = false
  ;(context as { simulatorUiExtensions: unknown }).simulatorUiExtensions = {
    register: (): SimulatorUiExtensionHandle => ({
      dispose: () => { disposed = true },
      invoke: async <T>(method: string) => {
        calls.push(method)
        return `${label}:${method}` as T
      },
    }),
    // The window's own teardown clears its registry; the recorder stands in for
    // the whole surface, so it has to answer that too.
    attach: () => {},
    detach: () => {},
    clear: () => {},
  }
  return { calls, isDisposed: () => disposed }
}

describe('a host simulator UI extension across project windows', () => {
  it('invokes into the active project window, never the project list', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const first = await openProjectWindow(instance, '/tmp/uiExtA1')
    const second = await openProjectWindow(instance, '/tmp/uiExtA2')
    const firstCalls = recordExtensionsOf(first.context, 'first')
    const secondCalls = recordExtensionsOf(second.context, 'second')

    const handle = instance.registerSimulatorUiExtension(REGISTRATION)

    // The project list holds app focus (nothing has focused a project window),
    // and it is exactly then that the extension must still reach the project.
    await expect(
      handle.invoke('ping'),
      'an extension drives the simulator, so its invoke belongs to the project window the user is working in — the project list has no simulator to reach',
    ).resolves.toBe('second:ping')
    expect(
      firstCalls.calls,
      'only the active project window answers; a background project must not receive the call',
    ).toEqual([])
    expect(secondCalls.calls).toEqual(['ping'])

    await handle.dispose()
    await instance.dispose()
  })

  it('stops reaching a window that has been closed', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const only = await openProjectWindow(instance, '/tmp/uiExtB')
    const onlyCalls = recordExtensionsOf(only.context, 'only')

    const handle = instance.registerSimulatorUiExtension(REGISTRATION)

    emitClose(only.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(only.window.isDestroyed()).toBe(true)
    }, { timeout: 2000 })

    // Wrapped in a call the host awaits, which is what the failure has to reach
    // whether it arrives as a throw or a rejected promise.
    await expect(
      (async () => handle.invoke('ping'))(),
      'with the last project window closed there is nothing to invoke into; the host must be told so rather than driven into a torn-down window',
    ).rejects.toThrow(/no live window/i)
    expect(
      onlyCalls.calls,
      'the closed window extension was disposed with it — a target record that outlives the window sends the host into a dead extension',
    ).toEqual([])
    expect(onlyCalls.isDisposed(), 'the window close disposes the extension it owned').toBe(true)

    await handle.dispose()
    await instance.dispose()
  })
})
