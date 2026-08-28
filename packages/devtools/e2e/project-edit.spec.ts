import type { Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect } from './fixtures'
import { ipcInvoke, addProject, refreshProjectList } from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

/**
 * Exercises the full rename/icon-edit path through renderer → IPC → main →
 * real project directory, which `project-repository.test.ts`'s in-memory fs
 * cannot: it can only assert the module wrote the right bytes, not that a
 * real Electron round-trip (contextBridge, React dialog, `projects:update`
 * handler) actually reaches disk and that a later re-import reads it back.
 *
 * Every project directory here is a one-off `mkdtemp` under `os.tmpdir()` —
 * never `DEMO_APP_DIR` — because renaming writes
 * `project.private.config.json` into the project directory itself, and that
 * must not land in the repo-tracked demo app.
 */

function writeMinimalProject(projectname: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-devtools-edit-'))
  fs.writeFileSync(path.join(dir, 'app.js'), 'App({})\n')
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
    pages: ['pages/index/index'],
    window: { navigationBarTitleText: 'Edit Test' },
  }, null, 2))
  fs.mkdirSync(path.join(dir, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages/index/index.js'), 'Page({})\n')
  fs.writeFileSync(path.join(dir, 'pages/index/index.wxml'), '<view />\n')
  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({
    appid: 'devtools_edit_test',
    projectname,
  }, null, 2))
  return dir
}

function removeTestProject(dir: string) {
  return async ({ mainWindow }: { mainWindow: Page }) => {
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, dir).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Resolve the whole `[data-qd-card]` element for `dir` instead of the inner
 * `[title="<dir>"]` node the other specs use — that inner node is the path
 * label alone (see `ProjectCardFooter`), a sibling of the name label and the
 * icon `<img>`, not an ancestor of either. `:has()` finds the card no matter
 * how deep the path label sits inside it.
 */
function cardFor(mainWindow: Page, dir: string) {
  return mainWindow.locator(`[data-qd-card]:has([title="${dir}"])`).first()
}

test.describe('project edit dialog: rename + icon write through to the real project directory', () => {
  test('renaming writes the new name into project.private.config.json without touching project.config.json', async ({ mainWindow }) => {
    const dir = writeMinimalProject('devtools-edit-original')
    try {
      await addProject(mainWindow, dir)
      await refreshProjectList(mainWindow)

      const card = mainWindow.locator(`[title="${dir}"]`).first()
      await card.waitFor()

      await mainWindow.getByRole('button', { name: `编辑 devtools-edit-original` }).click()
      const newName = '我的测试项目'
      const nameInput = mainWindow.getByLabel('项目名称')
      await nameInput.fill(newName)
      await mainWindow.getByRole('button', { name: '保存' }).click()

      await expect(cardFor(mainWindow, dir).locator(`[title="${newName}"]`)).toHaveText(newName)

      const privateConfigPath = path.join(dir, 'project.private.config.json')
      const privateConfig = JSON.parse(fs.readFileSync(privateConfigPath, 'utf-8'))
      expect(privateConfig.projectname).toBe(encodeURIComponent(newName))

      const publicConfig = JSON.parse(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf-8'))
      expect(publicConfig.projectname).toBe('devtools-edit-original')
    } finally {
      await removeTestProject(dir)({ mainWindow })
    }
  })

  test('re-importing the same directory after a rename keeps the new name, not the config default', async ({ mainWindow }) => {
    const dir = writeMinimalProject('devtools-edit-reimport')
    try {
      await addProject(mainWindow, dir)
      await refreshProjectList(mainWindow)

      await mainWindow.getByRole('button', { name: '编辑 devtools-edit-reimport' }).click()
      const renamedTo = '重新导入后的名字'
      await mainWindow.getByLabel('项目名称').fill(renamedTo)
      await mainWindow.getByRole('button', { name: '保存' }).click()
      await expect(cardFor(mainWindow, dir).locator(`[title="${renamedTo}"]`)).toHaveText(renamedTo)

      // Drop the record (not the directory) and re-add it — this is the only
      // way `addProject` actually runs its `readProjectName` lookup instead
      // of short-circuiting on an existing path (see helpers.ts `addProject`).
      await ipcInvoke(mainWindow, ProjectsChannel.Remove, dir)
      await refreshProjectList(mainWindow)
      await addProject(mainWindow, dir)
      await refreshProjectList(mainWindow)

      await expect(cardFor(mainWindow, dir).locator(`[title="${renamedTo}"]`)).toHaveText(renamedTo)
    } finally {
      await removeTestProject(dir)({ mainWindow })
    }
  })

  test('editing only the icon does not touch the project directory', async ({ mainWindow }) => {
    const dir = writeMinimalProject('devtools-edit-icon-only')
    try {
      await addProject(mainWindow, dir)
      await refreshProjectList(mainWindow)

      await mainWindow.getByRole('button', { name: '编辑 devtools-edit-icon-only' }).click()
      // A data: URL rather than a remote one: `ProjectCardIcon` drops the
      // <img> and falls back to the name's first letter as soon as loading
      // fails, so a remote address would make this assertion a race against
      // DNS — green with network, red without.
      await mainWindow.getByLabel('图标地址').fill('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
      await mainWindow.getByRole('button', { name: '保存' }).click()

      await expect(cardFor(mainWindow, dir).locator('img[src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"]')).toBeVisible()

      // Icon-only edits never write `patch.name`, so `updateProject` never
      // reaches `writeProjectName` — the project directory must stay exactly
      // as `writeMinimalProject` left it.
      expect(fs.existsSync(path.join(dir, 'project.private.config.json'))).toBe(false)
    } finally {
      await removeTestProject(dir)({ mainWindow })
    }
  })
})
