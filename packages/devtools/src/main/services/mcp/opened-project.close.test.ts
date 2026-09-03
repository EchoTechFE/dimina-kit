/**
 * Pinning the window an MCP-driven project close is aimed at.
 *
 * `project_close` resolves its target once, up front, and closes THAT window
 * after the session teardown finishes. The pin therefore has to capture the
 * window, not re-read "whichever window is active" when it is finally used.
 */
import { describe, expect, it } from 'vitest'
import { createCloseForMcp } from './opened-project.js'

describe('the project window an MCP close is pinned to', () => {
  it('stays on the window that was active when the pin was taken', () => {
    const closed: string[] = []
    const a = { window: 'winA', context: { id: 'a' } }
    const b = { window: 'winB', context: { id: 'b' } }
    let active = a.context

    const pin = createCloseForMcp({
      list: () => [a, b],
      activeContext: () => active,
      close: (window) => { closed.push(window) },
    })

    const closeA = pin()
    // The user clicks project B's window before the pinned close is used.
    active = b.context
    closeA?.()

    expect(
      closed,
      'a pin taken while A was active must close A even once B has focus',
    ).toEqual(['winA'])
  })

  it('reports no window when the active context owns none', () => {
    const pin = createCloseForMcp({
      list: () => [],
      activeContext: () => ({ id: 'list-window' }),
      close: () => { throw new Error('nothing to close') },
    })

    expect(
      pin(),
      'with no project window open there is nothing to take down, and the caller must be told so rather than handed a closer over an unrelated window',
    ).toBeNull()
  })
})
