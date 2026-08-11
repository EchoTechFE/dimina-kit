/** @vitest-environment jsdom */
/**
 * A stack change reaches main as two separate bridge calls — the full ordered
 * stack and the new active page — and the order between them is a contract,
 * not an implementation detail.
 *
 * ACTIVE_PAGE is automation's unlock signal: `waitForActivePage` treats it as
 * "the navigation finished" and lets the RPC return. `App.getPageStack` falls
 * back to reporting just the active page whenever main holds no stack of its
 * own, and main drops its stack when a page closes. So an ACTIVE_PAGE that
 * arrives before the new PAGE_STACK opens a window where the navigation call
 * has already returned to the caller while `getPageStack` still answers with a
 * single page. The stack has to be in place before the signal that releases
 * whoever is waiting on it.
 */
import { act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import {
  APP_SESSION_ID,
  bootShell,
  FORCED_PAGE,
  HOME_PAGE,
  INNER_PAGE,
  ROOT_BRIDGE_ID,
  serviceNav,
  type HostRecorder,
} from './__test-stubs__/miniapp-frame-harness.js'


/** Drives one `navigateBack` the way the service host issues it. */
async function navigateBack(recorder: HostRecorder): Promise<void> {
  await act(async () => {
    recorder.fire(E.NAV_ACTION, {
      appSessionId: APP_SESSION_ID,
      bridgeId: ROOT_BRIDGE_ID,
      name: 'navigateBack',
      params: { delta: 1 },
      callbacks: {},
    })
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('MiniAppFrame — navigateBack pops a page off a three-page stack', () => {
  it('reports the new stack to main before it reports the new active page', async () => {
    const { recorder } = await bootShell(HOME_PAGE)
    await serviceNav(recorder, 'navigateTo', INNER_PAGE)
    await serviceNav(recorder, 'navigateTo', FORCED_PAGE)
    const inner = recorder.openedEntries.find((page) => page.pagePath === INNER_PAGE)!
    const mark = recorder.calls.length

    await navigateBack(recorder)

    const calls = recorder.calls.slice(mark)
    const stackIndex = calls.findIndex((call) => call.kind === 'pageStack')
    const activeIndex = calls.findIndex((call) => call.kind === 'activePage')
    expect(stackIndex, 'no stack report for this change').toBeGreaterThanOrEqual(0)
    expect(activeIndex, 'no active-page report for this change').toBeGreaterThanOrEqual(0)
    // Both reports describe the post-back state, so ordering them is meaningful.
    expect(calls[stackIndex]).toEqual({ kind: 'pageStack', stack: [HOME_PAGE, INNER_PAGE] })
    expect(calls[activeIndex]).toEqual({ kind: 'activePage', bridgeId: inner.bridgeId })
    expect(stackIndex).toBeLessThan(activeIndex)
  })
})
