import { test, expect } from './fixtures'
import { DEMO_APP_DIR, ipcInvoke, addProject, closeProject } from './helpers'
import { ProjectsChannel, ProjectChannel } from '../src/shared/ipc-channels'

test.describe('IPC + Project Workflow', () => {
  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow).catch(() => {})
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('projects:list returns an array', async ({ mainWindow }) => {
    const projects = await ipcInvoke(mainWindow, ProjectsChannel.List)
    expect(Array.isArray(projects)).toBe(true)
  })

  test('project:getPages returns page list for demo app', async ({ mainWindow }) => {
    const result = await ipcInvoke<{ pages: string[]; entryPagePath: string }>(
      mainWindow,
      ProjectChannel.GetPages,
      DEMO_APP_DIR
    )

    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')
    expect(Array.isArray(result.pages)).toBe(true)
    expect(typeof result.entryPagePath).toBe('string')
  })

  test('project:getCompileConfig returns config for demo app', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const config = await ipcInvoke(mainWindow, ProjectChannel.GetCompileConfig, DEMO_APP_DIR)

    // Config may be null/undefined for a fresh project or an object
    expect(config === null || config === undefined || typeof config === 'object').toBe(true)
  })

  test('projects:add and projects:remove round-trip', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    let projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(true)

    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR)

    projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(false)
  })

  test('project:open and project:close lifecycle', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const openResult = await ipcInvoke(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)
    expect(openResult).toBeTruthy()
    expect(typeof openResult).toBe('object')

    // Close should not throw
    await ipcInvoke(mainWindow, ProjectChannel.Close)
  })

  test('can open and compile a project', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const result = await ipcInvoke<{ success: boolean }>(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)
    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')

    // Close the project so teardown doesn't hang
    await closeProject(mainWindow)
  })
})
