/** @vitest-environment jsdom */
/**
 * The shell's nav queue has to serialize STATE, not merely promises: two
 * routing actions dispatched inside one tick must each reduce from the stack
 * its predecessor committed. The shell reads the current stack through a ref
 * that React refreshes only after a commit, so a queue that chains promises
 * alone hands the second action the pre-action snapshot — the first action's
 * work is then either redone (a page popped/opened twice) or lost (a page
 * dropped from state with no closePage, i.e. a leaked render host).
 *
 * These suites dispatch OUTSIDE `act()` on purpose: `act` flushes React
 * synchronously between the two dispatches and closes exactly the window under
 * test. `IS_REACT_ACT_ENVIRONMENT` is turned off so React keeps its production
 * scheduling instead of warning about the unwrapped updates.
 */
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import {
  APP_SESSION_ID,
  bootShell,
  FORCED_PAGE,
  homeButton,
  HOME_PAGE,
  INNER_PAGE,
  latestStack,
  mountedPageCount,
  ROOT_BRIDGE_ID,
  serviceNav,
  visiblePagePath,
  type HostRecorder,
} from './__test-stubs__/miniapp-frame-harness.js'

type ActFlag = { IS_REACT_ACT_ENVIRONMENT?: boolean }

let actEnvironment: boolean | undefined

beforeEach(() => {
  actEnvironment = (globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT
})

afterEach(() => {
  ;(globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT = actEnvironment
})

/** Hands React the real scheduler so queued work spans commits. */
function leaveActEnvironment(): void {
  ;(globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT = false
}

/** Waits for React's own commit + the queue's microtasks, without act(). */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50) })
}

function dispatchBack(recorder: HostRecorder): void {
  recorder.fire(E.NAV_ACTION, {
    appSessionId: APP_SESSION_ID,
    bridgeId: ROOT_BRIDGE_ID,
    name: 'navigateBack',
    params: { delta: 1 },
    callbacks: {},
  })
}

describe('MiniAppFrame — two navigateBack actions land in the same tick', () => {
  it('tears down both popped pages, each exactly once, newest first', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)
    await serviceNav(recorder, 'navigateTo', INNER_PAGE)
    await serviceNav(recorder, 'navigateTo', FORCED_PAGE)
    const inner = recorder.openedEntries.find((page) => page.pagePath === INNER_PAGE)!
    const forced = recorder.openedEntries.find((page) => page.pagePath === FORCED_PAGE)!
    expect(inner.bridgeId).not.toBe(forced.bridgeId)
    recorder.closedPages.length = 0
    recorder.lifecycles.length = 0

    leaveActEnvironment()
    dispatchBack(recorder)
    dispatchBack(recorder)
    await settle()

    expect(latestStack(recorder)).toEqual([HOME_PAGE])
    expect(visiblePagePath(container)).toBe(HOME_PAGE)
    // Identity, not just cardinality: an implementation that pops twice while
    // dropping the teardown effects leaves an empty ledger, which any
    // duplicate-free check accepts while both render hosts leak.
    expect(recorder.closedPages).toEqual([forced.bridgeId, inner.bridgeId])
    // The service layer learns a page died only through this bridge call, so
    // the delivered sequence is asserted, not the reducer's effect list.
    expect(recorder.lifecycles).toEqual([
      { bridgeId: forced.bridgeId, event: 'pageUnload' },
      { bridgeId: inner.bridgeId, event: 'pageShow' },
      { bridgeId: inner.bridgeId, event: 'pageUnload' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
    ])
  })
})

describe('MiniAppFrame — the home button is clicked twice inside one tick', () => {
  it('lands on the home page alone and closes the page it left, once', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)
    const release = recorder.gateOpenPage()

    leaveActEnvironment()
    fireEvent.click(homeButton(container)!)
    fireEvent.click(homeButton(container)!)
    release()
    await settle()

    expect(recorder.openedPages.length).toBeLessThanOrEqual(1)
    // Equal counts alone are satisfied by an unfinished navigation: one home
    // page opened but never committed, one launch page still on screen. The
    // committed stack and the visible page pin down which page won.
    expect(latestStack(recorder)).toEqual([HOME_PAGE])
    expect(visiblePagePath(container)).toBe(HOME_PAGE)
    expect(recorder.closedPages).toEqual([ROOT_BRIDGE_ID])
    const home = recorder.openedEntries.find((page) => page.pagePath === HOME_PAGE)!
    expect(recorder.lifecycles).toEqual([
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageUnload' },
      { bridgeId: home.bridgeId, event: 'pageShow' },
    ])
    // Ledger: an opened page is either still mounted or was handed back to the
    // host for teardown. Anything else is a render host nobody owns.
    const unaccounted = recorder.openedEntries
      .filter((page) => !recorder.closedPages.includes(page.bridgeId))
    expect(unaccounted.length).toBe(mountedPageCount(container))
  })
})
