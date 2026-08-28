import { test, expect } from './fixtures'
import { DEMO_APP_DIR, addProject, refreshProjectList, ipcInvoke } from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

/**
 * A project card is one design unit whose metrics all derive from its own
 * column width (`--qd-card-u`, design.css). The grid column is elastic, so the
 * regression this guards is a card whose preview area scales with the column
 * while its info row stays a fixed pixel height — the card's aspect ratio then
 * drifts as the window widens, and the create card stops matching its
 * neighbours. jsdom has no layout, so this can only be measured in a real
 * window.
 */

/** Read every card's laid-out size, keyed by whether it is the create card. */
async function measureCards(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('[data-qd-card]')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        isCreateCard: el.tagName === 'BUTTON',
        width: r.width,
        height: r.height,
      }
    })
  })
}

async function setWindowWidth(
  electronApp: import('@playwright/test').ElectronApplication,
  width: number,
): Promise<void> {
  await electronApp.evaluate(async ({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()
      .find((b) => !b.isDestroyed() && b.webContents.getURL().includes('entries/main/'))
    if (!win) throw new Error('[e2e] no live main window to resize')
    const [, h] = win.getSize()
    win.setSize(w, h)
  }, width)
}

test.describe('project card proportions', () => {
  let originalWidth = 0

  test.beforeEach(async ({ electronApp, mainWindow }) => {
    originalWidth = await electronApp.evaluate(async ({ BrowserWindow }) => {
      // The main window by its own URL — devtools also owns secondary windows,
      // and creation order does not identify this one (see `findMainWindow`).
      const win = BrowserWindow.getAllWindows()
        .find((b) => !b.isDestroyed() && b.webContents.getURL().includes('entries/main/'))
      return win ? win.getSize()[0] : 0
    })
    await addProject(mainWindow, DEMO_APP_DIR)
    await refreshProjectList(mainWindow)
    await mainWindow.waitForSelector('[data-qd-card]')
  })

  test.afterEach(async ({ electronApp, mainWindow }) => {
    if (originalWidth > 0) await setWindowWidth(electronApp, originalWidth)
    // The Electron app is worker-scoped and shared with every later spec —
    // a project left in the list changes what those specs' own `addProject`
    // calls do (it skips a project already listed, so their setup silently
    // stops running).
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('cards keep one aspect ratio as the elastic grid widens them', async ({ electronApp, mainWindow }) => {
    const ratios: number[] = []
    // Two widths far enough apart that the auto-fill grid gives its columns
    // visibly different widths, without changing the column COUNT (which would
    // compare cards at the same width and prove nothing).
    for (const windowWidth of [1000, 1400]) {
      await setWindowWidth(electronApp, windowWidth)
      await expect
        .poll(async () => (await measureCards(mainWindow))[0]?.width ?? 0)
        .toBeGreaterThan(0)
      const cards = await measureCards(mainWindow)
      expect(cards.length).toBeGreaterThan(0)
      ratios.push(cards[0].height / cards[0].width)
    }

    expect(ratios[0]).toBeGreaterThan(0)
    // A fixed-pixel info row makes the taller/narrower card measurably
    // "squarer" as the column grows; a fully proportional card does not move.
    expect(Math.abs(ratios[1] - ratios[0])).toBeLessThan(0.02)
  })

  test('the create card matches a real project card at the same column width', async ({ electronApp, mainWindow }) => {
    await setWindowWidth(electronApp, 1200)
    await expect
      .poll(async () => (await measureCards(mainWindow)).length)
      .toBeGreaterThan(1)

    const cards = await measureCards(mainWindow)
    const createCard = cards.find((c) => c.isCreateCard)
    const projectCard = cards.find((c) => !c.isCreateCard)
    expect(createCard, 'create card missing from the grid').toBeTruthy()
    expect(projectCard, 'no project card in the grid').toBeTruthy()
    // Same row, so equal width is the grid's doing; equal HEIGHT is the part
    // the create card has to achieve on its own (it is the only item in an
    // empty list, with no sibling to be stretched against).
    expect(Math.abs(createCard!.height - projectCard!.height)).toBeLessThan(1)
  })
})
