import { test, expect } from './fixtures'
import { DEMO_APP_DIR, ipcInvoke, addProject, closeProject } from './helpers'
import { ProjectsChannel, ProjectChannel } from '../src/shared/ipc-channels'

test.describe('Project Workflow', () => {
  test('can add a project directory via IPC', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(Array.isArray(projects)).toBe(true)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(true)
  })

  test('project appears in list after adding', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(Array.isArray(projects)).toBe(true)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(true)
  })

  test('can open and compile a project', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const result = await ipcInvoke<{ success: boolean }>(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)
    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')

    // Close the project so teardown doesn't hang
    await closeProject(mainWindow)
  })

  test('can close a project', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await ipcInvoke(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)

    await ipcInvoke(mainWindow, ProjectChannel.Close)
    // No error thrown means success
  })

  test('can remove a project', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR)

    const projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(false)
  })
})
