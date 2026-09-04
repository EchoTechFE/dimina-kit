/**
 * LIST-WINDOW CLOSE GUARD (per-project-window architecture).
 *
 * The project-list window is the app's only way back to the project list,
 * and it registers app-level IPC that cannot be registered a second time on
 * a replacement window (see app.ts's `registerWorkbenchIpc`). So while any
 * project window is open, closing the list window must NOT destroy it: the
 * close is intercepted and the window is hidden instead — `revealWindow`
 * (see `workbench-window-reveal-on-close.test.ts`) is the only way back.
 *
 * Two cases must NOT be intercepted, or the app becomes unclosable:
 *  - no project window is open (there is nothing left to come back to);
 *  - a real application quit is already underway (`isAppQuitting()`), where
 *    intercepting would swallow ⌘Q / menu Quit and strand the process.
 *
 * Harness (electron/fs/devkit mocks + `createDevtoolsRuntime` lifecycle) is
 * shared with `workbench-window-reveal-on-close.test.ts` via
 * `window-close-reveal.harness.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  openProjectWindow,
  makeCloseEvent,
  emitClose,
} from './window-close-reveal.harness.js'

const state = registerRuntimeTestLifecycle()

describe('list window close guard', () => {
  it('with a project window open, close is intercepted: the window hides instead of being destroyed, and its context stays live', async () => {
    const instance = await state.createDevtoolsRuntime({})
    await openProjectWindow(instance, '/tmp/projGuardA')
    expect(instance.projectWindows().length).toBe(1)

    const disposeSpy = vi.spyOn(instance.context.registry, 'dispose')
    const destroySpy = vi.mocked(instance.mainWindow.destroy)
    const hideSpy = vi.mocked(instance.mainWindow.hide)

    const { event, prevented } = makeCloseEvent()
    emitClose(instance.mainWindow, event)
    // Drain a macrotask so a (buggy) async teardown would have run by now.
    await new Promise((r) => setTimeout(r, 0))

    expect(
      prevented(),
      'a project is still open — closing the list window must not let it be destroyed, or the user loses the only way back to the project list',
    ).toBe(true)
    expect(hideSpy, 'the window must hide, not merely stay open untouched').toHaveBeenCalledTimes(1)
    expect(destroySpy).not.toHaveBeenCalled()
    expect(
      disposeSpy,
      'an intercepted close must not tear down the app-level IPC this window owns — it cannot be re-registered on a replacement window',
    ).not.toHaveBeenCalled()

    await instance.dispose()
  })

  it('with no project window open, close is NOT intercepted and really disposes the window (or the app could never quit)', async () => {
    const instance = await state.createDevtoolsRuntime({})
    expect(instance.projectWindows().length).toBe(0)

    const disposeSpy = vi.spyOn(instance.context.registry, 'dispose')
    const hideSpy = vi.mocked(instance.mainWindow.hide)

    const { event, prevented } = makeCloseEvent()
    emitClose(instance.mainWindow, event)
    await vi.waitFor(() => {
      expect(disposeSpy).toHaveBeenCalledTimes(1)
    })

    expect(
      prevented(),
      'nothing is open behind the list window — its close must go through untouched',
    ).toBe(false)
    expect(hideSpy).not.toHaveBeenCalled()
  })

  it('once a real quit is underway (before-quit fired), close is NOT intercepted even with a project window still open', async () => {
    const instance = await state.createDevtoolsRuntime({})
    await openProjectWindow(instance, '/tmp/projGuardC')
    expect(instance.projectWindows().length).toBe(1)

    state.registerAppLifecycle()
    ;(state.electron.app as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(
      'before-quit',
      { preventDefault: () => {} },
    )
    expect(state.isAppQuitting()).toBe(true)

    const hideSpy = vi.mocked(instance.mainWindow.hide)
    const { event, prevented } = makeCloseEvent()
    emitClose(instance.mainWindow, event)
    await new Promise((r) => setTimeout(r, 0))

    expect(
      prevented(),
      '⌘Q must not be swallowed by the "keep the list window alive" guard, or the app can never exit with a project open',
    ).toBe(false)
    expect(hideSpy).not.toHaveBeenCalled()

    await instance.dispose()
  })
})
