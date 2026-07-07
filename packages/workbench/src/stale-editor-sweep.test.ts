import { describe, expect, it } from 'vitest'
import {
  closeStaleWorkspaceEditors,
  type TabGroupsLike,
  type TabLike,
  type UriLike,
} from './stale-editor-sweep.js'

/**
 * Minimal stand-ins for the vscode.TabInputText constructor and tab/group
 * shapes this sweep inspects. The real `vscode` module only resolves inside
 * the workbench iframe runtime, so tests supply their own — only the shape
 * `closeStaleWorkspaceEditors` reads is reproduced.
 */
class StubTabInputText {
  uri: UriLike
  constructor(uri: UriLike) {
    this.uri = uri
  }
}

class OtherTabInput {
  original: UriLike
  modified: UriLike
  constructor(original: UriLike, modified: UriLike) {
    this.original = original
    this.modified = modified
  }
}

function textTab(uri: UriLike, isDirty = false): TabLike {
  return { isDirty, input: new StubTabInputText(uri) }
}

function fileUri(path: string): UriLike {
  return { scheme: 'file', path }
}

/** Records tabGroups.close() calls; exists() is driven per test via a map/fn. */
function makeTabGroups(groups: TabLike[][]): { tabGroups: TabGroupsLike; closedCalls: TabLike[][] } {
  const closedCalls: TabLike[][] = []
  const tabGroups: TabGroupsLike = {
    all: groups.map(tabs => ({ tabs })),
    close: async (tabs: TabLike[]) => {
      closedCalls.push(tabs)
      return true
    },
  }
  return { tabGroups, closedCalls }
}

const workspaceRoot: UriLike = { scheme: 'file', path: '/workspace' }

describe('closeStaleWorkspaceEditors — closes tabs for files missing from the mounted workspace', () => {
  it('closes a workspace-root text tab whose file no longer exists and reports it in the count', async () => {
    const staleTab = textTab(fileUri('/workspace/pages/index/index.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[staleTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(1)
    expect(closedCalls).toEqual([[staleTab]])
  })
})

describe('closeStaleWorkspaceEditors — leaves editors for files that still exist alone', () => {
  it('does not close a workspace-root text tab whose file exists in the new project mirror', async () => {
    const liveTab = textTab(fileUri('/workspace/pages/index/index.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[liveTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => true,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })
})

describe('closeStaleWorkspaceEditors — never touches non-text editors', () => {
  it('skips a diff-style tab input and never probes exists() for it', async () => {
    let existsCalls = 0
    const diffTab: TabLike = {
      isDirty: false,
      input: new OtherTabInput(fileUri('/workspace/a.wxml'), fileUri('/workspace/b.wxml')),
    }
    const { tabGroups, closedCalls } = makeTabGroups([[diffTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => {
        existsCalls += 1
        return false
      },
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
    expect(existsCalls).toBe(0)
  })

  it('skips a tab whose input is undefined and never probes exists() for it', async () => {
    let existsCalls = 0
    const emptyTab: TabLike = { isDirty: false, input: undefined }
    const { tabGroups, closedCalls } = makeTabGroups([[emptyTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => {
        existsCalls += 1
        return false
      },
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
    expect(existsCalls).toBe(0)
  })
})

describe('closeStaleWorkspaceEditors — respects the workspace-root path boundary', () => {
  it('does not close a text tab whose scheme is not file even when the path matches', async () => {
    const nonFileTab = textTab({ scheme: 'untitled', path: '/workspace/scratch.wxml' })
    const { tabGroups, closedCalls } = makeTabGroups([[nonFileTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })

  it('does not close a sibling directory that merely shares the workspace-root prefix as a string', async () => {
    // '/workspace2/foo' starts with the string '/workspace' but is not inside
    // the '/workspace' root — a naive startsWith(path) check would misfire here.
    const siblingTab = textTab(fileUri('/workspace2/foo.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[siblingTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })

  it('closes a stale file nested in a subdirectory of the workspace root', async () => {
    const nestedTab = textTab(fileUri('/workspace/sub/x.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[nestedTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(1)
    expect(closedCalls).toEqual([[nestedTab]])
  })
})

describe('closeStaleWorkspaceEditors — preserves unsaved edits', () => {
  it('does not close a dirty workspace-root text tab even when its file no longer exists', async () => {
    const dirtyTab = textTab(fileUri('/workspace/pages/index/index.wxml'), true)
    const { tabGroups, closedCalls } = makeTabGroups([[dirtyTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })
})

describe('closeStaleWorkspaceEditors — sweeps every tab group, not just the first', () => {
  it('closes stale tabs found across multiple tab groups', async () => {
    const staleA = textTab(fileUri('/workspace/a.wxml'))
    const staleB = textTab(fileUri('/workspace/b.wxml'))
    const liveC = textTab(fileUri('/workspace/c.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[staleA], [staleB, liveC]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async uri => uri.path === '/workspace/c.wxml',
    })

    expect(closedCount).toBe(2)
    const closedFlat = closedCalls.flat()
    expect(closedFlat).toContain(staleA)
    expect(closedFlat).toContain(staleB)
    expect(closedFlat).not.toContain(liveC)
  })
})

describe('closeStaleWorkspaceEditors — tolerates individual exists() probe failures', () => {
  it('keeps the tab whose exists() probe rejects, while still closing other stale tabs, and does not reject itself', async () => {
    const floodedTab = textTab(fileUri('/workspace/flooded.wxml'))
    const staleTab = textTab(fileUri('/workspace/stale.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[floodedTab, staleTab]])

    const result = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async uri => {
        if (uri.path === '/workspace/flooded.wxml') {
          throw new Error('probe failed')
        }
        return false
      },
    })

    expect(result).toBe(1)
    const closedFlat = closedCalls.flat()
    expect(closedFlat).toContain(staleTab)
    expect(closedFlat).not.toContain(floodedTab)
  })
})

describe('closeStaleWorkspaceEditors — no-op when nothing is stale', () => {
  it('never calls tabGroups.close and returns 0 when there are no stale tabs', async () => {
    const liveTab = textTab(fileUri('/workspace/index.wxml'))
    const { tabGroups, closedCalls } = makeTabGroups([[liveTab]])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => true,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })

  it('returns 0 without calling close when there are no tabs at all', async () => {
    const { tabGroups, closedCalls } = makeTabGroups([])

    const closedCount = await closeStaleWorkspaceEditors({
      tabGroups,
      TabInputText: StubTabInputText,
      workspaceRoot,
      exists: async () => false,
    })

    expect(closedCount).toBe(0)
    expect(closedCalls).toEqual([])
  })
})
