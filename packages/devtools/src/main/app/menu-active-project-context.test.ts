/**
 * The menu drives the project the user is actually in.
 *
 * A project lives in its own window while the project list stays open, so a
 * menu item like "关闭当前项目" or "读取当前 session" must resolve the active
 * project window every time it runs. Binding the menu to one context at
 * install time pins it to the list window forever: `hasActiveSession()` is
 * then always false, `getProjectPath()` always empty, and `closeProject()`
 * never reaches the project the user is looking at.
 *
 * The menu is installed once, before any project window exists, so this is a
 * per-call resolution — not a snapshot taken at install time.
 */
import { describe, it, expect, vi } from 'vitest'
import type { MenuContext } from '../../shared/types.js'
import { registerRuntimeTestLifecycle, openProjectWindow } from './window-close-reveal.harness.js'

const state = registerRuntimeTestLifecycle()

async function bootWithMenu(): Promise<{
  instance: Awaited<ReturnType<typeof state.createDevtoolsRuntime>>
  menu: MenuContext
}> {
  let captured: MenuContext | undefined
  const instance = await state.createDevtoolsRuntime({
    menuBuilder: (_window, menuContext) => { captured = menuContext },
  })
  expect(captured, 'setup: menuBuilder must receive the menu context').toBeDefined()
  return { instance, menu: captured! }
}

describe('the workspace a host menu builder drives', () => {
  it('follows the active project window instead of staying on the project list', async () => {
    const { instance, menu } = await bootWithMenu()

    expect(
      menu.workspace.getProjectPath(),
      'with no project open the list window answers, and it owns no project',
    ).toBe('')

    const first = await openProjectWindow(instance, '/tmp/menuActiveA')
    first.context.workspace.getProjectPath = () => '/tmp/menuActiveA'
    first.context.workspace.hasActiveSession = () => true

    expect(
      menu.workspace.getProjectPath(),
      'a menu item must read the project the user has open, not the empty list window',
    ).toBe('/tmp/menuActiveA')
    expect(
      menu.workspace.hasActiveSession(),
      'a session-gated menu item must stay enabled while a project window is open',
    ).toBe(true)

    const second = await openProjectWindow(instance, '/tmp/menuActiveB')
    second.context.workspace.getProjectPath = () => '/tmp/menuActiveB'

    expect(
      menu.workspace.getProjectPath(),
      'opening a second project moves the menu onto it — the menu is installed only once',
    ).toBe('/tmp/menuActiveB')

    await instance.dispose()
  })

  it('closes the active project window, not the project list session', async () => {
    const { instance, menu } = await bootWithMenu()
    const listClose = vi.fn(async () => {})
    instance.context.workspace.closeProject = listClose

    const projectWindow = await openProjectWindow(instance, '/tmp/menuActiveClose')
    const projectClose = vi.fn(async () => {})
    projectWindow.context.workspace.closeProject = projectClose

    await menu.workspace.closeProject()

    expect(projectClose, '"关闭当前项目" must reach the open project window').toHaveBeenCalledTimes(1)
    expect(listClose, 'the project list owns no session to close').not.toHaveBeenCalled()

    await instance.dispose()
  })

  it('keeps a host monkey-patch of the active window openProject interceptable', async () => {
    const { instance, menu } = await bootWithMenu()
    const projectWindow = await openProjectWindow(instance, '/tmp/menuActivePatch')

    const intercepted: string[] = []
    projectWindow.context.workspace.openProject = async (projectPath: string) => {
      intercepted.push(projectPath)
      return { success: false, error: 'denied by host' }
    }

    const result = await menu.workspace.openProject('/tmp/other')

    expect(
      intercepted,
      'the documented permission-gate pattern patches the live context, so the menu must read it per call',
    ).toEqual(['/tmp/other'])
    expect(result).toMatchObject({ success: false, error: 'denied by host' })

    await instance.dispose()
  })
})
