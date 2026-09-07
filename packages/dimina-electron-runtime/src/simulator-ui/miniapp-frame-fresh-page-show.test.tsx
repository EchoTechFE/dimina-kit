/** @vitest-environment jsdom */
/**
 * MiniAppFrame must push `pageShow` to the host for every page that becomes
 * the stack top — including the launch page (which has no prior reducer call
 * to hang an effect off) and a freshly navigateTo'd page (which today only
 * gets a pageHide for the page it replaced). Without this, service's
 * runtime.js never calls onShow/onReady for a page until it is later
 * restored from a tab cache via navigateBack/switchTab.
 */
import { describe, expect, it } from 'vitest'
import {
  bootShell,
  HOME_PAGE,
  INNER_PAGE,
  ROOT_BRIDGE_ID,
  serviceNav,
  serviceNavBack,
} from './__test-stubs__/miniapp-frame-harness.js'

describe('MiniAppFrame — freshly opened pages report their own pageShow', () => {
  it('pushes exactly one pageShow for the entry page right after mount', async () => {
    const { recorder } = await bootShell(HOME_PAGE)

    expect(recorder.lifecycles).toEqual([{ bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' }])
  })

  it('pushes pageHide(old) then pageShow(new) after a navigateTo, on top of the launch pageShow', async () => {
    const { recorder } = await bootShell(HOME_PAGE)
    await serviceNav(recorder, 'navigateTo', INNER_PAGE)

    const newBridgeId = recorder.openedEntries.find((p) => p.pagePath === INNER_PAGE)?.bridgeId
    expect(newBridgeId).toBeTruthy()
    expect(recorder.lifecycles).toEqual([
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageHide' },
      { bridgeId: newBridgeId, event: 'pageShow' },
    ])
  })
})

describe('MiniAppFrame — active gates the freshly-opened pageShow', () => {
  it('does not push pageShow while mounted inactive', async () => {
    const { recorder } = await bootShell(HOME_PAGE, { active: false })

    expect(recorder.lifecycles).toEqual([])
  })

  it('pushes exactly one pageShow when active flips from false to true', async () => {
    const { recorder, setActive } = await bootShell(HOME_PAGE, { active: false })
    expect(recorder.lifecycles).toEqual([])

    await setActive(true)

    expect(recorder.lifecycles).toEqual([{ bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' }])
  })

  it('does not repeat pageShow across false→true→false→true toggles', async () => {
    const { recorder, setActive } = await bootShell(HOME_PAGE, { active: false })
    expect(recorder.lifecycles).toEqual([])

    await setActive(true)
    await setActive(false)
    await setActive(true)

    expect(recorder.lifecycles).toEqual([{ bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' }])
  })
})

describe('MiniAppFrame — inactive gates navigation-driven lifecycle, not just the launch pageShow', () => {
  it('suppresses navigateTo lifecycle while inactive, then on activation shows only the new stack top', async () => {
    const { recorder, setActive } = await bootShell(HOME_PAGE, { active: false })

    await serviceNav(recorder, 'navigateTo', INNER_PAGE)
    expect(recorder.lifecycles).toEqual([])

    const innerBridgeId = recorder.openedEntries.find((p) => p.pagePath === INNER_PAGE)?.bridgeId
    expect(innerBridgeId).toBeTruthy()

    await setActive(true)
    expect(recorder.lifecycles).toEqual([{ bridgeId: innerBridgeId, event: 'pageShow' }])

    await serviceNavBack(recorder)
    expect(recorder.lifecycles).toEqual([
      { bridgeId: innerBridgeId, event: 'pageShow' },
      { bridgeId: innerBridgeId, event: 'pageUnload' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
    ])
  })

  it('suppresses redirectTo pageShow while inactive; only the redirected-to page shows on activation, never the page it replaced', async () => {
    const { recorder, setActive } = await bootShell(HOME_PAGE, { active: false })

    await serviceNav(recorder, 'redirectTo', INNER_PAGE)
    expect(recorder.lifecycles.filter((e) => e.event === 'pageShow' || e.event === 'pageHide')).toEqual([])

    const innerBridgeId = recorder.openedEntries.find((p) => p.pagePath === INNER_PAGE)?.bridgeId
    expect(innerBridgeId).toBeTruthy()
    const beforeActivate = recorder.lifecycles.length

    await setActive(true)
    expect(recorder.lifecycles.slice(beforeActivate)).toEqual([{ bridgeId: innerBridgeId, event: 'pageShow' }])
    expect(recorder.lifecycles.some((e) => e.bridgeId === ROOT_BRIDGE_ID && e.event === 'pageShow')).toBe(false)
  })
})
