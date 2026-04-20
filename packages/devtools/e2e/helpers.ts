import type { Page, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProjectsChannel, ProjectChannel, SimulatorChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Paths ──────────────────────────────────────────────────────────────

const DEMO_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'demo-app'),
]

function resolveDemoAppDir(): string {
  const found = DEMO_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'project.config.json')))
  if (!found) {
    throw new Error(`No demo app found. Checked: ${DEMO_CANDIDATES.join(', ')}`)
  }
  return found
}

function readDemoProjectName(projectDir: string): string {
  try {
    const configPath = path.join(projectDir, 'project.config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectname?: string; appid?: string }
    return config.projectname || config.appid || path.basename(projectDir)
  } catch {
    return path.basename(projectDir)
  }
}

/** Source demo mini-app for compilation tests. */
export const DEMO_APP_DIR = resolveDemoAppDir()
export const DEMO_APP_NAME = readDemoProjectName(DEMO_APP_DIR)

// ── IPC helpers ────────────────────────────────────────────────────────

/**
 * Invoke an IPC handler from the renderer process.
 * Wraps the common `window.require('electron').ipcRenderer.invoke(...)` pattern.
 */
export async function ipcInvoke<T = unknown>(
  mainWindow: Page,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return mainWindow.evaluate(
    async ({ channel, args }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke(channel, ...args)
    },
    { channel, args }
  ) as Promise<T>
}

// ── Project lifecycle ──────────────────────────────────────────────────

/**
 * Add a project via IPC (does not navigate to project view).
 */
export async function addProject(mainWindow: Page, projectDir: string): Promise<void> {
  await ipcInvoke(mainWindow, ProjectsChannel.Add, projectDir)
}

/**
 * Close the current project session via IPC and navigate back to the project list.
 * Safe to call when no project is open.
 */
export async function closeProject(mainWindow: Page): Promise<void> {
  await ipcInvoke(mainWindow, SimulatorChannel.Detach).catch(() => {})
  await ipcInvoke(mainWindow, ProjectChannel.Close).catch(() => {})
  // Trigger the navigate-back handler in the renderer (same event handleWindowClose sends)
  await mainWindow.evaluate(() => {
    const { ipcRenderer } = window.require('electron')
    // Emit locally to trigger the 'window:navigateBack' listener
    ipcRenderer.emit('window:navigateBack', {} as Electron.IpcRendererEvent)
  }).catch(() => {})
  // Wait for the project list view to be visible again (the project card title=projectDir
  // disappears once we leave the project view; project list shows project cards / empty state).
  // We can't know the path from here, so poll for the absence of the toolbar text "普通编译".
  await pollUntil(
    () => mainWindow.evaluate(() => !document.body.innerText.includes('普通编译')),
    (gone) => gone === true,
    5000,
    100,
  ).catch(() => {})
}

/**
 * Add a project and click its card to navigate to the project view.
 * Waits for the simulator webview to attach AND first-page DOM to be ready
 * (compile complete signal) instead of a fixed timer.
 *
 * @param waitMs - hard cap on total wait time (default 15000). Param kept for backwards compat.
 * @param waitForWebview - kept for backwards compat. The new implementation always waits for webview.
 */
export async function openProjectInUI(
  mainWindow: Page,
  projectDir: string,
  { waitMs = 15000, waitForWebview = true }: { waitMs?: number; waitForWebview?: boolean } = {}
): Promise<void> {
  await addProject(mainWindow, projectDir)
  await mainWindow.evaluate(() => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.emit('window:navigateBack', {} as Electron.IpcRendererEvent)
  })
  const projectPathLabel = mainWindow.locator(`[title="${projectDir}"]`).first()
  await projectPathLabel.waitFor()
  await projectPathLabel.locator('..').click()
  await mainWindow.waitForSelector('text=普通编译')

  void waitForWebview // accepted for backwards compat; behaviour below always waits

  const deadline = Date.now() + waitMs

  // 1) Wait for the simulator webview to attach.
  await mainWindow.waitForSelector('webview', { timeout: Math.max(1000, deadline - Date.now()) })
    .catch(() => {})

  // 2) Wait for the renderer to report compile complete or the toolbar to leave the
  //    "正在刷新..." / "正在编译..." state. The status text lives in a `.truncate` span
  //    bound to setCompileStatus messages: '编译完成', '编译完成，已热更新', '刷新完成'.
  await pollUntil(
    () => mainWindow.evaluate(() => {
      const els = document.querySelectorAll('[class*="truncate"]')
      for (const el of els) {
        const t = el.textContent || ''
        if (t.includes('完成')) return true
      }
      return false
    }),
    (done) => done === true,
    Math.max(1000, deadline - Date.now()),
    300,
  ).catch(() => {})
}

// ── Simulator helpers ──────────────────────────────────────────────────

/**
 * Execute JavaScript inside the simulator webview via the main process.
 * Retries up to 3 times if the webview is not yet available.
 */
export async function evalInSimulator<T = unknown>(
  electronApp: ElectronApplication,
  expression: string
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await electronApp.evaluate(async ({ webContents }, expr) => {
        const all = webContents.getAllWebContents()
        const sim = all.find((wc) => wc.getType() === 'webview')
        if (!sim) throw new Error('No webview found')
        return sim.executeJavaScript(expr)
      }, expression) as Promise<T>
    } catch (err) {
      lastErr = err
      const message = String(err)
      if (
        message.includes('No webview found')
        || message.includes('Script failed to execute')
      ) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export async function evalInWebContentsByUrl<T = unknown>(
  electronApp: ElectronApplication,
  urlSubstring: string,
  expression: string
): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const all = webContents.getAllWebContents()
    const target = all.find((wc) => wc.getURL().includes(payload.urlSubstring))
    if (!target) throw new Error(`No webContents found for ${payload.urlSubstring}`)
    return target.executeJavaScript(payload.expression)
  }, { urlSubstring, expression }) as Promise<T>
}

export async function waitForSimulatorWebview(
  electronApp: ElectronApplication,
  timeout = 20000
): Promise<void> {
  await pollUntil(
    () => electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents()
      return all.some((wc) => wc.getType() === 'webview')
    }),
    (present) => present === true,
    timeout,
    500
  )
}

// ── Polling / async helpers ────────────────────────────────────────────

/**
 * Poll `fn` until `predicate` returns true, up to `timeout` ms.
 * On timeout, makes one final attempt that is allowed to throw.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeout = 15000,
  interval = 500
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const val = await fn()
      if (predicate(val)) return val
    } catch {
      // ignore intermediate errors
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return fn() // final attempt — let it throw
}

// ── UI query helpers ───────────────────────────────────────────────────

/**
 * Find a button by its text content.
 */
export async function findButtonByText(
  mainWindow: Page,
  text: string
): Promise<boolean> {
  return mainWindow.evaluate((t) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.textContent?.includes(t)) return true
    }
    return false
  }, text)
}

/**
 * Find a button by its title attribute.
 */
export async function findButtonByTitle(
  mainWindow: Page,
  title: string
): Promise<boolean> {
  return mainWindow.evaluate((t) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if ((btn.getAttribute('title') || '').includes(t)) return true
    }
    return false
  }, title)
}

// ── Reset helpers (for shared-project pattern) ─────────────────────────

/**
 * Best-effort reset of in-simulator state between tests when reusing one
 * open project. Clears wx storage and resets to the home page when possible.
 */
export async function resetSimulatorState(
  electronApp: ElectronApplication,
  homePagePath = 'pages/index/index',
): Promise<void> {
  await evalInSimulator(electronApp, `try { wx.clearStorageSync() } catch (e) {}`).catch(() => {})

  // Try to get back to the home page via hash navigation. This is a soft reset:
  // if it fails (e.g. simulator not yet ready), we swallow the error so a single
  // bad test doesn't block the next.
  await evalInSimulator(
    electronApp,
    `(() => {
      try {
        const hash = location.hash.replace(/^#/, '')
        const appId = hash.includes('|') ? hash.split('|')[0] : hash.split('/')[0]
        if (!appId) return
        const target = '#' + appId + '|${homePagePath}'
        if (location.hash !== target) location.hash = target
      } catch (e) {}
    })()`,
  ).catch(() => {})
}
