import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'

export interface UpdateManagerOptions {
  checker: UpdateChecker
  mainWindow: BrowserWindow
  /** Check interval in milliseconds. Default: 1 hour */
  checkInterval?: number
}

export class UpdateManager {
  private checker: UpdateChecker
  private mainWindow: BrowserWindow
  private latestUpdate: UpdateInfo | null = null
  private downloadedPath: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: UpdateManagerOptions) {
    this.checker = opts.checker
    this.mainWindow = opts.mainWindow
    this.registerIpc()
    this.startPeriodicCheck(opts.checkInterval ?? 60 * 60 * 1000)
  }

  private registerIpc(): void {
    ipcMain.handle('updates:check', async () => {
      return this.check()
    })

    ipcMain.handle('updates:download', async () => {
      return this.download()
    })

    ipcMain.handle('updates:install', async () => {
      this.install()
    })
  }

  async check(): Promise<{ hasUpdate: boolean; info?: UpdateInfo }> {
    try {
      const currentVersion = app.getVersion()
      const info = await this.checker.checkForUpdates(currentVersion)
      if (info) {
        this.latestUpdate = info
        this.downloadedPath = null
        return { hasUpdate: true, info }
      }
      return { hasUpdate: false }
    } catch (err) {
      console.warn('[UpdateManager] check failed:', err)
      return { hasUpdate: false }
    }
  }

  async download(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (!this.latestUpdate) {
      return { success: false, error: 'No update available' }
    }
    try {
      const filePath = await this.checker.downloadUpdate(this.latestUpdate, (percent) => {
        this.mainWindow.webContents.send('updates:downloadProgress', { percent })
      })
      this.downloadedPath = filePath
      return { success: true, filePath }
    } catch (err) {
      console.warn('[UpdateManager] download failed:', err)
      return { success: false, error: String(err) }
    }
  }

  install(): void {
    if (this.downloadedPath) {
      shell.openPath(this.downloadedPath)
      app.quit()
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    ipcMain.removeHandler('updates:check')
    ipcMain.removeHandler('updates:download')
    ipcMain.removeHandler('updates:install')
  }

  private startPeriodicCheck(interval: number): void {
    // Check once after a short delay on startup
    setTimeout(() => void this.checkAndNotify(), 5000)
    this.timer = setInterval(() => void this.checkAndNotify(), interval)
  }

  private async checkAndNotify(): Promise<void> {
    const result = await this.check()
    if (result.hasUpdate && result.info) {
      this.mainWindow.webContents.send('updates:available', result.info)
    }
  }
}
