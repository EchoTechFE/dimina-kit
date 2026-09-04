/**
 * LIST-WINDOW REVEAL ON LAST PROJECT CLOSE (per-project-window architecture).
 *
 * The list window hides instead of closing while any project window is open
 * (see `main-window-close-guard.test.ts`). Once the LAST project window
 * closes, `onBeforeClose` in app.ts's `createWorkbenchWindowManager` config
 * must bring it back — otherwise the app keeps running with nothing on
 * screen. `revealWindow` (window-events.ts) both un-hides and un-minimizes
 * it.
 *
 * Closing one of SEVERAL open project windows must leave the list window
 * alone — it is not the one the user was looking at, and stealing focus to
 * it would be as wrong as leaving nothing on screen.
 *
 * Harness shared with `main-window-close-guard.test.ts` via
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

describe('list window reveal on last project window close', () => {
  it('re-shows a list window that was hidden behind the project it is closing', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const projectWindow = await openProjectWindow(instance, '/tmp/projRevealA')

    // Hide the list window the way the close guard does with a project open.
    emitClose(instance.mainWindow, makeCloseEvent().event)
    await new Promise((r) => setTimeout(r, 0))
    expect(instance.mainWindow.isVisible(), 'setup: list window must be hidden before the case under test').toBe(false)

    const showSpy = vi.mocked(instance.mainWindow.show)
    const focusSpy = vi.mocked(instance.mainWindow.focus)

    emitClose(projectWindow.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(instance.mainWindow.isVisible()).toBe(true)
    })

    expect(
      showSpy,
      'the last project window is gone — the user needs the list window back on screen',
    ).toHaveBeenCalled()
    expect(focusSpy).toHaveBeenCalled()

    await instance.dispose()
  })

  it('restores the list window first if it was minimized, then shows and focuses it', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const projectWindow = await openProjectWindow(instance, '/tmp/projRevealB')

    instance.mainWindow.minimize()
    expect(instance.mainWindow.isMinimized()).toBe(true)
    const restoreSpy = vi.mocked(instance.mainWindow.restore)

    emitClose(projectWindow.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(restoreSpy).toHaveBeenCalled()
    })
    expect(instance.mainWindow.isMinimized(), 'restore() must actually clear the minimized state').toBe(false)

    await instance.dispose()
  })

  it('closing one of several open project windows leaves the list window alone', async () => {
    const instance = await state.createDevtoolsRuntime({})
    const pw1 = await openProjectWindow(instance, '/tmp/projRevealC1')
    const pw2 = await openProjectWindow(instance, '/tmp/projRevealC2')
    expect(instance.projectWindows().length).toBe(2)
    void pw2

    const showSpy = vi.mocked(instance.mainWindow.show)
    const focusSpy = vi.mocked(instance.mainWindow.focus)

    emitClose(pw1.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(instance.projectWindows().length).toBe(1)
    })

    expect(
      showSpy,
      'another project window is still open — the list window must not be pulled to the front',
    ).not.toHaveBeenCalled()
    expect(focusSpy).not.toHaveBeenCalled()

    await instance.dispose()
  })
})
