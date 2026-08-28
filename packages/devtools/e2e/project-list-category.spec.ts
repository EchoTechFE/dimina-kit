import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, ipcInvoke, addProject, refreshProjectList, selectProjectCategoryInUI } from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Real submodule fixture — `compileType: "game"`, `game.json`/`game.js`, no `app.json`. */
const MINI_GAME_DIR = path.resolve(__dirname, '..', '..', '..', 'dimina', 'fe', 'example', 'air-battle')

test.describe('project list: category rail filters by project type', () => {
  test.afterEach(async ({ mainWindow }) => {
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, MINI_GAME_DIR).catch(() => {})
  })

  test('miniprogram category shows miniprogram projects, hides mini-game projects', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, MINI_GAME_DIR)
    await addProject(mainWindow, DEMO_APP_DIR)
    await refreshProjectList(mainWindow)
    // Select explicitly rather than relying on '小程序' being the initial
    // category: the Electron app is worker-scoped, so an earlier spec may have
    // left the rail on 小游戏.
    await selectProjectCategoryInUI(electronApp, 'miniprogram')

    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toHaveCount(0)
  })

  test('switching to 小游戏 shows mini-game projects, hides miniprogram projects', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await addProject(mainWindow, MINI_GAME_DIR)
    await refreshProjectList(mainWindow)

    await selectProjectCategoryInUI(electronApp, 'minigame')

    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toHaveCount(0)
  })

  test('switching back to 小程序 restores the miniprogram-only view', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await addProject(mainWindow, MINI_GAME_DIR)
    await refreshProjectList(mainWindow)

    await selectProjectCategoryInUI(electronApp, 'minigame')
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toBeVisible()

    await selectProjectCategoryInUI(electronApp, 'miniprogram')
    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toHaveCount(0)
  })
})
