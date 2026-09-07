/** @vitest-environment jsdom */
/**
 * `navigateHome` is a terminal-state action: once the stack holds nothing but
 * the app's home page, running it again must be a no-op. Re-opening the page,
 * tearing it down and rebuilding it, or replaying its `pageShow` all hand the
 * user (and the service layer) a lifecycle that never happened.
 */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import {
  APP_SESSION_ID,
  bootShell,
  homeButton,
  HOME_PAGE,
  INNER_PAGE,
  ROOT_BRIDGE_ID,
  visiblePagePath,
  type HostRecorder,
} from './__test-stubs__/miniapp-frame-harness.js'

function dispatchNavigateHome(recorder: HostRecorder): void {
  recorder.fire(E.NAV_ACTION, {
    appSessionId: APP_SESSION_ID,
    bridgeId: ROOT_BRIDGE_ID,
    name: 'navigateHome',
    params: {},
    callbacks: {},
  })
}

describe('MiniAppFrame — navigateHome runs again on the home page', () => {
  it('keeps the home page it already reached, opening and closing nothing', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })
    await waitFor(() => {
      expect(visiblePagePath(container)).toBe(HOME_PAGE)
    })

    // Mounting shows the launch page; the trip to home then tears it down and
    // shows the freshly-opened home page — all three lifecycles reach the bridge.
    const homeBridgeId = recorder.openedEntries[0]!.bridgeId
    expect(recorder.lifecycles).toEqual([
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageUnload' },
      { bridgeId: homeBridgeId, event: 'pageShow' },
    ])
    const openedBefore = recorder.openedPages.length
    const closedBefore = recorder.closedPages.length
    const lifecycleBefore = recorder.lifecycles.length

    await act(async () => {
      dispatchNavigateHome(recorder)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(recorder.openedPages.length).toBe(openedBefore)
    expect(recorder.closedPages.length).toBe(closedBefore)
    expect(visiblePagePath(container)).toBe(HOME_PAGE)
    expect(recorder.lifecycles.slice(lifecycleBefore)).toEqual([])
  })
})
