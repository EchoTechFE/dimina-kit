/**
 * "打开项目" in the menu must bring the PROJECT-LIST window forward, not
 * whatever window `activeContext()` currently resolves to. `activeContext()`
 * tracks the focused project window while one is open, so routing the click
 * through `activeContext().notify.windowNavigateBack()` sends the refresh
 * notification to the project window itself instead of the list. `installMenu`
 * takes an injected `revealProjectList` for this exact purpose — the menu
 * must call it, and must stop reaching into `activeContext()` for this item.
 */
import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { MenuContext, WorkbenchAppConfig } from '../../shared/types.js'
import { installMenu as installMenuUntyped, type MenuHostContext } from './menu-setup.js'

// menu-setup.ts pulls in `../menu/index.js`, which imports `Menu` from
// 'electron' at module load time even though a host `menuBuilder` (used
// below) bypasses it at runtime — so the module still needs to resolve.
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}))

// `installMenu` does not take a `revealProjectList` parameter yet — that is
// exactly the contract this suite is pinning ahead of the fix. Typing the
// call against the post-fix signature (rather than loosening it to `any`)
// keeps every other argument checked, and lets the extra argument through
// as a plain no-op on today's implementation instead of a type error.
type InstallMenuAfterFix = (
  config: WorkbenchAppConfig,
  mainWindow: BrowserWindow,
  activeContext: () => MenuHostContext,
  revealProjectList: () => void,
) => void
const installMenu = installMenuUntyped as unknown as InstallMenuAfterFix

function makeActiveContext(): { activeContext: () => MenuHostContext; activeNotifyBack: ReturnType<typeof vi.fn> } {
  const activeNotifyBack = vi.fn()
  const ctx = {
    appName: 'Test',
    workspace: {
      hasActiveSession: () => false,
      getProjectPath: () => '',
      openProject: async () => ({ success: true }),
      closeProject: async () => {},
      getSession: () => null,
    },
    openSettings: async () => {},
    notify: {
      projectStatus: () => {},
      windowNavigateBack: activeNotifyBack,
    },
  } as unknown as MenuHostContext
  return { activeContext: () => ctx, activeNotifyBack }
}

// Today's (unfixed) `windowNavigateBack` closure still calls
// `revealWindow(listWindow)` before reaching `activeContext()`, so
// `mainWindow` needs real no-op window methods — a bare `{}` would throw
// inside `revealWindow` and mask the assertions this suite exists to make.
function makeMainWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow
}

function captureMenuContext(revealProjectList: () => void, activeContext: () => MenuHostContext): MenuContext {
  let captured: MenuContext | undefined
  const config: WorkbenchAppConfig = {
    menuBuilder: (_win, menuContext) => { captured = menuContext },
  }
  const mainWindow = makeMainWindow()
  installMenu(config, mainWindow, activeContext, revealProjectList)
  expect(captured, 'setup: menuBuilder must receive the menu context').toBeDefined()
  return captured!
}

describe('installMenu "back to project list" routes through the injected surface', () => {
  it('calls the injected revealProjectList exactly once per click', () => {
    const { activeContext } = makeActiveContext()
    const revealProjectList = vi.fn()
    const menu = captureMenuContext(revealProjectList, activeContext)

    menu.notify.windowNavigateBack()

    expect(revealProjectList).toHaveBeenCalledTimes(1)
  })

  it('no longer notifies the active window\'s own context — that context may be a project window, not the list', () => {
    const { activeContext, activeNotifyBack } = makeActiveContext()
    const revealProjectList = vi.fn()
    const menu = captureMenuContext(revealProjectList, activeContext)

    menu.notify.windowNavigateBack()

    expect(
      activeNotifyBack,
      'routing through activeContext() sends the refresh to whatever window is focused, not the list',
    ).not.toHaveBeenCalled()
  })
})
