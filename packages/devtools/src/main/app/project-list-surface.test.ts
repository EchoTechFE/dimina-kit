/**
 * "回到项目列表" and the update dialog both belong to the project-list
 * window — never to whichever window happens to be `activeContext()` at
 * call time. `createProjectListSurface` is the single place both flows
 * route through: `revealProjectList()` brings the list window forward and
 * tells its OWN context to refresh, and `showUpdate()` reveals the list
 * window before showing the dialog so a hidden list window never eats an
 * update prompt no one can see.
 */
import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { UpdateInfo } from '../../shared/types.js'
import { createProjectListSurface } from './project-list-surface.js'

interface FakeWindow {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

function makeWindow(state: { destroyed?: boolean; minimized?: boolean } = {}): FakeWindow {
  return {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

function makeSurface(window: FakeWindow, calls: string[] = []) {
  const windowNavigateBack = vi.fn(() => { calls.push('reveal') })
  const showUpdateDialog = vi.fn((_info: UpdateInfo) => { calls.push('dialog') })
  const surface = createProjectListSurface({
    window: window as unknown as BrowserWindow,
    context: {
      notify: { windowNavigateBack },
      views: { showUpdateDialog },
    },
  })
  return { surface, windowNavigateBack, showUpdateDialog, calls }
}

describe('createProjectListSurface.revealProjectList', () => {
  it('shows and focuses a hidden list window without restoring it', () => {
    const window = makeWindow()
    const { surface, windowNavigateBack } = makeSurface(window)

    surface.revealProjectList()

    expect(window.restore, 'not minimized, so restore() must not run').not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(windowNavigateBack, 'the list window\'s own context must be told to refresh').toHaveBeenCalledTimes(1)
  })

  it('restores a minimized list window before showing and focusing it', () => {
    const window = makeWindow({ minimized: true })
    const { surface } = makeSurface(window)

    surface.revealProjectList()

    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('still notifies the list context but skips show/focus/restore on a destroyed window', () => {
    const window = makeWindow({ destroyed: true })
    const { surface, windowNavigateBack } = makeSurface(window)

    expect(() => surface.revealProjectList()).not.toThrow()

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(windowNavigateBack).toHaveBeenCalledTimes(1)
  })

  it('reveals and notifies exactly once per call, not once per surface', () => {
    const window = makeWindow()
    const { surface, windowNavigateBack } = makeSurface(window)

    surface.revealProjectList()
    surface.revealProjectList()

    expect(window.show).toHaveBeenCalledTimes(2)
    expect(windowNavigateBack).toHaveBeenCalledTimes(2)
  })
})

describe('createProjectListSurface.showUpdate', () => {
  it('reveals the list window before showing the update dialog, with the same info object', () => {
    const window = makeWindow()
    const calls: string[] = []
    const { surface, showUpdateDialog } = makeSurface(window, calls)
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }

    surface.showUpdate(info)

    expect(calls, 'reveal must happen before the dialog, or a hidden window eats the prompt').toEqual(['reveal', 'dialog'])
    expect(showUpdateDialog).toHaveBeenCalledTimes(1)
    expect(showUpdateDialog.mock.calls[0][0], 'the dialog must receive the exact info object, not a copy').toBe(info)
  })

  it('brings a hidden list window forward as part of showing the update', () => {
    const window = makeWindow()
    const { surface } = makeSurface(window)
    const info: UpdateInfo = { version: '3.1.0', downloadUrl: 'https://example.com/3.1.0.dmg' }

    surface.showUpdate(info)

    expect(window.show, 'the update dialog is useless if the window that hosts it stays hidden').toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })
})
