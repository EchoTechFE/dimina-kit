/**
 * Integration test: launch devtools, open demo project, then run
 * the demo-app/auto-test.js script using miniprogram-automator.
 */

import { test, expect, _electron } from '@playwright/test'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  ipcInvoke,
  pollUntil,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function runScript(scriptPath: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, stdout, stderr: stderr + '\n[KILLED BY TIMEOUT]' }) }, 60_000)
  })
}

test.describe('Demo App auto-test.js', () => {
  test.setTimeout(120_000)

  test('miniprogram-automator 驱动 demo 小程序测试', async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      __dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata',
      `run-demo-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })
    const electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    try {
      const mainWindow = await electronApp.firstWindow()
      await mainWindow.waitForLoadState('domcontentloaded')
      await electronApp.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) { win.setPosition(-2000, -2000); win.blur() }
      })

      const autoPort = await pollUntil(
        () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
        (val) => typeof val === 'number' && val > 0,
        10000,
        100,
      ) as number

      await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 8000, waitForWebview: true })
      await waitForSimulatorWebview(electronApp)
      await new Promise((r) => setTimeout(r, 3000))

      const scriptPath = path.resolve(DEMO_APP_DIR, 'auto-test.js')
      const { code, stdout, stderr } = await runScript(scriptPath, { AUTO_PORT: String(autoPort) })

      // Print output for visibility
      if (stdout) console.log(stdout)
      if (stderr) console.error('STDERR:', stderr)

      expect(code).toBe(0)
      expect(stdout).toContain('通过')
    } finally {
      // Force kill to avoid teardown timeout
      electronApp.process().kill('SIGKILL')
    }
  })
})
