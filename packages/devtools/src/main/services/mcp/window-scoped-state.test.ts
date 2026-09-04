/**
 * MCP runtime state belongs to a WINDOW, not to the process.
 *
 * Each project runs in its own window, so "is this native-host", "which render
 * guest is visible", "how do I read the cross-process overview" and "which
 * project is this" are facts about one window. MCP's tool surface takes no
 * window argument, so it reads the window the user is working in — and one
 * window closing must leave every other open window's state untouched.
 *
 * The `workbench` CDP target follows the same rule: it is the active project's
 * workbench renderer, and only falls back to the project-list window when no
 * project window is open.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeMcpWindow,
  getNativeOverviewProvider,
  noteActiveBridgeId,
  registerMcpWindow,
  selectWorkbenchTarget,
  setActiveMcpWindowResolver,
  type McpWindowRegistration,
  type NativeOverview,
} from './target-manager.js'

const EMPTY_OVERVIEW: NativeOverview = {
  currentRoute: null,
  pageStackDepth: 0,
  storageKeys: [],
  storageCount: 0,
  appDataKeys: [],
}

/** Stands in for one project window: an opaque owner token plus its facts. */
function openWindow(projectPath: string, nativeHost = true): {
  owner: object
  registration: McpWindowRegistration
  overview: () => Promise<NativeOverview>
} {
  const owner = { projectPath }
  const overview = async (): Promise<NativeOverview> => ({ ...EMPTY_OVERVIEW, currentRoute: projectPath })
  const registration = registerMcpWindow(owner, {
    nativeHost,
    activeBridgeId: null,
    nativeOverviewProvider: nativeHost ? overview : null,
    projectPath,
    getAppId: () => null,
  })
  return { owner, registration, overview }
}

afterEach(() => {
  setActiveMcpWindowResolver(() => null)
})

describe('two project windows open at once', () => {
  it('reads the native overview of the window the user is working in', async () => {
    const a = openWindow('/proj/a')
    const b = openWindow('/proj/b')

    let active: object = a.owner
    setActiveMcpWindowResolver(() => active)
    expect(
      await getNativeOverviewProvider()?.(),
      'MCP must read the overview of the active project window',
    ).toMatchObject({ currentRoute: '/proj/a' })

    active = b.owner
    expect(
      await getNativeOverviewProvider()?.(),
      'switching the active window must switch the overview MCP reads',
    ).toMatchObject({ currentRoute: '/proj/b' })

    a.registration.dispose()
    b.registration.dispose()
  })

  it('closing one project window leaves the other window native-host state intact', async () => {
    const a = openWindow('/proj/a')
    const b = openWindow('/proj/b')
    setActiveMcpWindowResolver(() => b.owner)

    a.registration.dispose()

    expect(
      activeMcpWindow()?.nativeHost,
      'closing another project must not drop the still-open window out of native-host mode',
    ).toBe(true)
    expect(
      await getNativeOverviewProvider()?.(),
      'closing another project must not strip the still-open window native overview',
    ).toMatchObject({ currentRoute: '/proj/b' })

    b.registration.dispose()
  })

  it('a background window navigating never re-points MCP at its page', () => {
    const a = openWindow('/proj/a')
    const b = openWindow('/proj/b')
    setActiveMcpWindowResolver(() => b.owner)

    noteActiveBridgeId(b.owner, 'bridge-b')
    noteActiveBridgeId(a.owner, 'bridge-a')

    expect(
      activeMcpWindow()?.activeBridgeId,
      'a navigation in a background project window must not steal the MCP simulator target',
    ).toBe('bridge-b')

    a.registration.dispose()
    b.registration.dispose()
  })

  it('reports no window state once every project window is gone', () => {
    const a = openWindow('/proj/a')
    setActiveMcpWindowResolver(() => a.owner)
    a.registration.dispose()

    expect(activeMcpWindow(), 'a disposed window must not answer for MCP any more').toBeNull()
    expect(getNativeOverviewProvider()).toBeNull()
  })
})

describe('selectWorkbenchTarget', () => {
  const listWindow = { type: 'page', url: 'file:///app/dist/entries/main/index.html' }
  const workbenchA = {
    type: 'page',
    url: 'file:///app/dist/entries/workbench/index.html?path=%2Fproj%2Fa&name=a',
  }
  const workbenchB = {
    type: 'page',
    url: 'file:///app/dist/entries/workbench/index.html?path=%2Fproj%2Fb&name=b',
  }
  // The service host for project B: its URL carries the SAME project directory,
  // which is why the project path alone can never be the match criterion.
  const serviceHostB = {
    type: 'page',
    url: 'file:///app/dist/service-host/index.html?pkgRoot=%2Fproj%2Fb&appId=demo',
  }
  const simulatorShell = { type: 'page', url: 'http://localhost:7788/simulator.html' }

  it('picks the workbench window of the active project, not the project list', () => {
    const picked = selectWorkbenchTarget(
      [listWindow, simulatorShell, workbenchA, serviceHostB, workbenchB],
      { projectPath: '/proj/b' },
    )
    expect(
      picked,
      'MCP workbench tools must reach the project workbench the user is in, not the project list',
    ).toBe(workbenchB)
  })

  it('never picks the service host that merely carries the same project directory', () => {
    const picked = selectWorkbenchTarget([listWindow, serviceHostB, simulatorShell], {
      projectPath: '/proj/b',
    })
    expect(
      picked,
      'a service-host window is not a workbench renderer, even with the project dir in its URL — and with a project open the list is not a stand-in for it either',
    ).toBeUndefined()
  })

  it('falls back to the project list when no project window is open', () => {
    const picked = selectWorkbenchTarget([workbenchA, listWindow, simulatorShell], {
      projectPath: null,
    })
    expect(picked, 'with no active project the list window is the workbench surface').toBe(listWindow)
  })

  it('picks a workbench window whose session has not started yet', () => {
    const picked = selectWorkbenchTarget([listWindow, workbenchA], { projectPath: '/proj/a' })
    expect(
      picked,
      'a window is matched on the path it opened with, so it is the target from the moment it exists — nothing has to compile first',
    ).toBe(workbenchA)
  })

  it('never picks the simulator shell', () => {
    expect(selectWorkbenchTarget([simulatorShell], { projectPath: '/proj/a' })).toBeUndefined()
    expect(selectWorkbenchTarget([simulatorShell], { projectPath: null })).toBeUndefined()
  })
})
