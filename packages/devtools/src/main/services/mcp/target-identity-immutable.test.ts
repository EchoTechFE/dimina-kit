/**
 * A project window's identity is fixed the moment it opens, not read live off
 * compile/session state — and the workbench target selector trusts nothing
 * but an exact match against that identity.
 *
 * `getProjectPath()` answered '' until a window's first compile recorded a
 * path, so a workbench window just opened (before any build ran) named no
 * project at all: nothing could tell its own renderer apart from another
 * project's, and `selectWorkbenchTarget` papered over the gap by falling back
 * to "the first workbench page" or the project list — landing MCP on whichever
 * window happened to come first, not the one actually open.
 *
 * The project path a window opened with never changes for the life of that
 * window, so it belongs on `TargetIdentityFacts`/`McpWindowFacts` as a plain
 * value fixed at registration (`projectPath`), not a function that reads
 * session state that may not exist yet. And once matching is exact-or-nothing,
 * "no match" has to mean exactly that — never another window's page, never the
 * project list standing in for a project that IS open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionOwner, type TargetIdentityFacts } from './connection-owner.js'

const cdp = vi.hoisted(() => ({
  listed: [] as { type: string; url: string }[],
  connectedTo: [] as string[],
}))

vi.mock('chrome-remote-interface', () => {
  const noop = () => {}
  const makeClient = () => ({
    Page: { enable: async () => {} },
    Runtime: { enable: async () => {}, on: noop },
    DOM: { enable: async () => {} },
    Network: { enable: async () => {}, on: noop },
    Console: { enable: async () => {}, on: noop },
    on: noop,
    close: async () => {},
  })
  const CDP = Object.assign(
    vi.fn(async ({ target }: { target: { url: string } }) => {
      cdp.connectedTo.push(target.url)
      return makeClient()
    }),
    { List: vi.fn(async () => cdp.listed) },
  )
  return { default: CDP }
})

async function loadTargetManager() {
  vi.resetModules()
  return await import('./target-manager.js')
}

const LIST_URL = 'file:///app/dist/entries/main/index.html'
const workbenchUrl = (path: string) =>
  `file:///app/dist/entries/workbench/index.html?path=${encodeURIComponent(path)}&name=p`

beforeEach(() => {
  vi.useFakeTimers()
  cdp.listed = []
  cdp.connectedTo = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a window's project path fixed at registration", () => {
  it('is found by an exact target match even though its compile session has not started', () => {
    const b = {}
    const windows = new Map<object, TargetIdentityFacts>([
      [b, { activeBridgeId: null, projectPath: '/proj/b', getAppId: () => 'app-b' }],
    ])

    const binding = connectionOwner('workbench', workbenchUrl('/proj/b'), b, windows)

    expect(
      binding,
      "a window carries the project path it opened with from registration on — nothing about compiling should be required before its own renderer target can be attributed to it",
    ).toEqual({ owner: b, onTarget: true })
  })

  it("lets a just-opened workbench window connect to its own renderer before any build has run", async () => {
    const tm = await loadTargetManager()
    const b = {}
    tm.registerMcpWindow(b, {
      nativeHost: true,
      activeBridgeId: null,
      nativeOverviewProvider: null,
      projectPath: '/proj/b',
      getAppId: () => 'app-b',
    })
    tm.setActiveMcpWindowResolver(() => b)
    cdp.listed = [
      { type: 'page', url: LIST_URL },
      { type: 'page', url: workbenchUrl('/proj/b') },
    ]

    await tm.connectTarget('workbench')

    expect(
      cdp.connectedTo,
      "the window's own path is known from the moment it registers, so the connection must land on it directly instead of degrading to the project list or another window's page",
    ).toEqual([workbenchUrl('/proj/b')])
  })
})

describe('selectWorkbenchTarget for the active project window', () => {
  it("returns no target rather than another window's page when nothing matches the active path exactly", async () => {
    const tm = await loadTargetManager()
    const candidates = [
      { type: 'page', url: LIST_URL },
      { type: 'page', url: workbenchUrl('/proj/other') },
    ]

    const result = tm.selectWorkbenchTarget(candidates, { projectPath: '/proj/mine' })

    expect(
      result,
      "a workbench page for a different project, or the project list, must never stand in for a project that IS open but not yet reachable",
    ).toBeUndefined()
  })
})
