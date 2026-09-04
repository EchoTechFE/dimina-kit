import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import {
  ipcInvoke,
  addProject,
  closeProject,
  openProjectInUI,
  selectProjectCategoryInUI,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
  installConsoleCollector,
  readConsoleErrors,
} from './helpers'
import { ProjectsChannel, ProjectChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Real submodule fixture — `compileType: "game"`, `game.json`/`game.js`, no `app.json`. */
const MINI_GAME_DIR = path.resolve(__dirname, '..', '..', '..', 'dimina', 'fe', 'example', 'air-battle')

interface OpenProjectResult {
  success: boolean
  port?: number
  appInfo?: { appId: string }
  error?: string
}

test.describe('mini-game project support', () => {
  // Most tests below drive `ProjectChannel.Open` directly (list window's own
  // WorkbenchContext, no real workbench window); the last test opens through
  // the UI (a real workbench BrowserWindow). Cover both close paths.
  test.afterEach(async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, ProjectChannel.Close).catch(() => {})
    await closeProject(electronApp).catch(() => {})
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, MINI_GAME_DIR).catch(() => {})
  })

  test('project:getPages resolves the synthetic game entry, not pages/index/index', async ({ mainWindow }) => {
    const result = await ipcInvoke<{ pages: string[]; entryPagePath: string }>(
      mainWindow,
      ProjectChannel.GetPages,
      MINI_GAME_DIR,
    )
    expect(result).toEqual({ pages: ['game'], entryPagePath: 'game' })
  })

  test('project:getCompileConfig defaults startPage to the game entry', async ({ mainWindow }) => {
    await addProject(mainWindow, MINI_GAME_DIR)
    const config = await ipcInvoke<{ startPage: string }>(mainWindow, ProjectChannel.GetCompileConfig, MINI_GAME_DIR)
    expect(config.startPage).toBe('game')
    expect(config.startPage).not.toBe('pages/index/index')
  })

  test('project:open compiles and launches the mini-game without falling back to a page path', async ({ mainWindow }) => {
    await addProject(mainWindow, MINI_GAME_DIR)
    const result = await ipcInvoke<OpenProjectResult>(mainWindow, ProjectChannel.Open, MINI_GAME_DIR)
    expect(result.success, `open failed: ${result.error}`).toBe(true)
  })

  // `mainWindow` is requested but unused: acquiring it is what health-checks
  // the app and relaunches a dead one, and that has to happen before this test
  // drives the UI, not when `afterEach` first asks for it.
  test('opening the project in the UI renders a real game canvas', async ({ electronApp, mainWindow: _mainWindow }) => {
    await installConsoleCollector(electronApp)
    // The project-list grid is filtered by category (default '小程序'); a
    // mini-game project's card only renders once '小游戏' is selected.
    await selectProjectCategoryInUI(electronApp, 'minigame')
    await openProjectInUI(electronApp, MINI_GAME_DIR)

    const hasGameCanvas = await evalInWebContentsByUrl<boolean>(
      electronApp,
      RENDER_GUEST_URL_MARKER,
      `(() => !!document.querySelector('[data-dimina-game-canvas]'))()`,
    ).catch(() => false)
    expect(hasGameCanvas).toBe(true)

    const errors = await readConsoleErrors(electronApp)
    const fatal = errors.filter((e) => /page is not declared|Unexpected token/.test(e.message))
    expect(fatal, JSON.stringify(fatal)).toEqual([])
  })
})
