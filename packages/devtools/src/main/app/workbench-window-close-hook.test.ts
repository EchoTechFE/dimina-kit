/**
 * THE HOST'S `onBeforeClose` HOOK AND THE CLOSING PROJECT WINDOW.
 *
 * Three properties of the close path, all about the boundary between host
 * code and the framework's own teardown:
 *
 * - Host code runs on the way out, but it cannot cancel the framework's
 *   cleanup. A hook that rejects still leaves the window disposed and the
 *   list window back on screen; otherwise the app keeps running with a dead
 *   session and, when the last project closes, nothing visible at all.
 * - The hook is told WHICH project is closing. With several project windows
 *   open, a hook that only gets the app instance cannot tell them apart —
 *   `instance.context` is always the list window's, which owns no session.
 * - "One window per project" holds for the WHOLE close, not just up to the
 *   moment the map entry is dropped. A re-open arriving while the hook is
 *   still running must wait, or the user gets two windows and two compile
 *   sessions on one directory.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntimeTestLifecycle,
  openProjectWindow,
  makeCloseEvent,
  emitClose,
} from './window-close-reveal.harness.js'

const state = registerRuntimeTestLifecycle()

interface DisposalProbe {
  registry: { add: (fn: () => void) => unknown }
}

/** A context is disposed exactly when its registry refuses new entries. */
function isDisposed(ctx: unknown): boolean {
  try {
    ;(ctx as DisposalProbe).registry.add(() => {})
    return false
  } catch {
    return true
  }
}

describe('host onBeforeClose that rejects', () => {
  it('still disposes the window and brings the list window back', async () => {
    const instance = await state.createDevtoolsRuntime({
      onBeforeClose: () => Promise.reject(new Error('host failed to save its state')),
    })
    const projectWindow = await openProjectWindow(instance, '/tmp/hookRejectReveal')

    // Hide the list window the way its close guard does with a project open.
    emitClose(instance.mainWindow, makeCloseEvent().event)
    await new Promise((r) => setTimeout(r, 0))
    expect(instance.mainWindow.isVisible(), 'setup: the list window must be hidden first').toBe(false)

    emitClose(projectWindow.window, makeCloseEvent().event)

    await vi.waitFor(() => {
      expect(projectWindow.window.isDestroyed()).toBe(true)
    }, { timeout: 2000 })
    expect(
      isDisposed(projectWindow.context),
      'host code must not be able to veto disposal of the session, bridge and editor server',
    ).toBe(true)
    expect(
      instance.mainWindow.isVisible(),
      'the last project window is gone — a failing host hook must not leave the user with nothing on screen',
    ).toBe(true)
    expect(instance.projectWindows()).toHaveLength(0)

    await instance.dispose()
  })
})

describe('the project handed to the host close hook', () => {
  it('identifies the window being closed, not the project list', async () => {
    interface ClosingArg { path: string; name?: string; context: unknown }
    const seen: ClosingArg[] = []
    const instance = await state.createDevtoolsRuntime({
      onBeforeClose: (_instance, closing) => {
        seen.push(closing as ClosingArg)
      },
    })
    const first = await openProjectWindow(instance, '/tmp/hookIdentityA')
    const second = await openProjectWindow(instance, '/tmp/hookIdentityB')

    emitClose(second.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1)
    })
    expect(
      seen[0]?.path,
      'a host saving per-project state needs to know which project is closing',
    ).toBe('/tmp/hookIdentityB')
    expect(
      seen[0]?.context,
      'the hook must receive the closing window\'s own context — the list window context owns no session',
    ).toBe(second.context)
    expect(seen[0]?.context).not.toBe(instance.context)

    emitClose(first.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2)
    })
    expect(
      seen[1]?.path,
      'each closing window must be reported as itself, not as whichever window closed first',
    ).toBe('/tmp/hookIdentityA')
    expect(seen[1]?.context).toBe(first.context)

    await instance.dispose()
  })
})

describe('re-opening a project while its window is still closing', () => {
  it('waits for the previous window to finish tearing down instead of racing a second one', async () => {
    let releaseHook!: () => void
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const events: string[] = []

    const instance = await state.createDevtoolsRuntime({
      onBeforeClose: async () => {
        events.push('hook-start')
        await hookGate
        events.push('hook-end')
      },
    })
    const first = await openProjectWindow(instance, '/tmp/reopenRace')
    const disposeFirst = first.dispose.bind(first)
    first.dispose = async () => {
      await disposeFirst()
      events.push('disposed')
    }

    emitClose(first.window, makeCloseEvent().event)
    await vi.waitFor(() => {
      expect(events).toContain('hook-start')
    })

    const reopen = instance.openProjectWindow({ path: '/tmp/reopenRace' }).then((win) => {
      events.push('reopened')
      return win
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(
      events,
      'a second window (and a second compile session) must not appear while the first is still tearing down',
    ).not.toContain('reopened')

    releaseHook()
    await reopen

    expect(
      events,
      'the re-open must be serialized behind the full teardown of the previous window',
    ).toEqual(['hook-start', 'hook-end', 'disposed', 'reopened'])
    expect(
      instance.projectWindows(),
      'one project, one window — including across a close/re-open overlap',
    ).toHaveLength(1)
    expect(instance.projectWindows()[0]).not.toBe(first)

    await instance.dispose()
  })
})
