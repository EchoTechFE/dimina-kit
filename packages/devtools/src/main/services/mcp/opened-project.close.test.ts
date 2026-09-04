/**
 * The project window an MCP tool call is aimed at.
 *
 * A call resolves its target once, up front, and every surface it uses — the
 * workspace, the status store, the window closer — comes from that one
 * snapshot. The snapshot therefore has to capture the window, not re-read
 * "whichever window is active" when it is finally used.
 */
import { describe, expect, it } from 'vitest'
import { createTargetForMcp, type McpTargetContext } from './opened-project.js'

/** A window context as the target factory reads it: three surfaces, identity-compared. */
function makeContext(id: string): McpTargetContext {
  return {
    workspace: { id } as unknown as McpTargetContext['workspace'],
    sessionStatus: { id } as unknown as McpTargetContext['sessionStatus'],
    compileLogBuffer: { id } as unknown as McpTargetContext['compileLogBuffer'],
  }
}

describe('the project window an MCP call is pinned to', () => {
  it('stays on the window that was active when the target was taken', () => {
    const closed: string[] = []
    const a = { window: 'winA', context: makeContext('a') }
    const b = { window: 'winB', context: makeContext('b') }
    let active = a.context

    const currentProject = createTargetForMcp({
      list: () => [a, b],
      activeContext: () => active,
      close: (window) => { closed.push(window) },
    })

    const target = currentProject()
    // The user clicks project B's window before the pinned close runs.
    active = b.context
    target.closeWindow()

    expect(
      closed,
      'a target taken while A was active must close A even once B has focus',
    ).toEqual(['winA'])
  })

  it('reads every surface off the same window context', () => {
    const a = { window: 'winA', context: makeContext('a') }
    const target = createTargetForMcp({
      list: () => [a],
      activeContext: () => a.context,
      close: () => {},
    })()

    expect(target.workspace).toBe(a.context.workspace)
    expect(target.sessionStatus).toBe(a.context.sessionStatus)
    expect(target.compileLogs).toBe(a.context.compileLogBuffer)
  })

  it('closes nothing when the active context owns no project window', () => {
    const listWindow = makeContext('list-window')
    const target = createTargetForMcp({
      list: () => [],
      activeContext: () => listWindow,
      close: () => { throw new Error('nothing to close') },
    })()

    expect(
      () => target.closeWindow(),
      'with no project window open there is nothing to take down, and the tool must not fail or close an unrelated window',
    ).not.toThrow()
  })
})
