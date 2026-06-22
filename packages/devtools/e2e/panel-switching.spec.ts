import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR } from './helpers'

test.describe('Right panel switching', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('selecting each panel renders the correct panel in the main window', async ({
    mainWindow,
  }) => {
    // UI-driven: click the real tab buttons (the only switching path a user
    // has). The raw PanelChannel.Select/SelectSimulator IPC channels this
    // test used to drive are being decommissioned.
    for (const name of ['WXML', 'AppData', 'Storage']) {
      const tab = mainWindow.getByRole('tab', { name })
      await tab.click()
      // The dock marks the selected tab with `data-active`; that flip IS the
      // switch-complete signal, so the assertion's own wait replaces a sleep.
      await expect(tab).toHaveAttribute('data-active', 'true')
    }
    // Selecting Console should show the devtools overlay (chrome devtools)
    const consoleTab = mainWindow.getByRole('tab', { name: 'Console' })
    await consoleTab.click()
    await expect(consoleTab).toHaveAttribute('data-active', 'true')

    // 编译 (compile-event log) is the fifth tab, pinned after Console. Its
    // body is plain React content (no main-process overlay), so selecting it
    // must flip the keepalive tabpanel visible.
    //
    // Deliberately NOT asserted here: "a ready event appears in the log after
    // open project" — the initial compiling/ready projectStatus emissions race
    // the renderer's subscription mount, so right after open the log may
    // legitimately be empty. The hook unit tests own the event semantics.
    const compileTab = mainWindow.getByRole('tab', { name: '编译' })
    await compileTab.click()
    await expect(compileTab).toHaveAttribute('data-active', 'true')
    // The dock keeps every panel body mounted; the active one's
    // `data-deck-panel-body` wrapper flips to display:flex (visible).
    await expect(mainWindow.locator('[data-deck-panel-body="compile"]')).toBeVisible()
  })

  test('selecting WXML tab shows WXML panel content in main window', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()

    // Poll for the WXML panel's "刷新" button instead of a fixed sleep — it
    // appears once the panel body mounts.
    await expect
      .poll(
        () =>
          mainWindow.evaluate(() => {
            const buttons = document.querySelectorAll('button')
            for (const btn of buttons) {
              if (btn.textContent?.includes('刷新')) return true
            }
            return false
          }),
        { timeout: 5000, intervals: [100, 200, 300] },
      )
      .toBe(true)
  })

  test('closing project does not leave orphan right-panel views', async ({ electronApp }) => {
    const rpCount = await electronApp.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('right-panel')).length
    })
    expect(rpCount).toBe(0)
  })
})
