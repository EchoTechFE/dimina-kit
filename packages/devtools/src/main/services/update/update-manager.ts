import { app, BrowserWindow, shell } from 'electron'
import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateChannel } from '../../../shared/ipc-channels.js'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'

export interface UpdateManagerOptions {
  checker: UpdateChecker
  mainWindow: BrowserWindow
  /** Check interval in milliseconds. Default: 1 hour */
  checkInterval?: number
  /** Delay before the first check after startup in ms. Default: 5000 */
  initialDelay?: number
  /** Override the version string passed to the checker. Default: app.getVersion() */
  getCurrentVersion?: () => string
  /**
   * Optional sender gate. When provided, IpcRegistry rejects invocations
   * whose `event.sender` is not whitelisted (same C-stage policy used by
   * every other workbench-built-in). Omitted in unit tests that mock
   * electron without a real WebContents.
   */
  senderPolicy?: SenderPolicy
}

export class UpdateManager {
  private checker: UpdateChecker
  private mainWindow: BrowserWindow
  private getCurrentVersion: () => string
  private latestUpdate: UpdateInfo | null = null
  private downloadedPath: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private ipc: IpcRegistry

  constructor(opts: UpdateManagerOptions) {
    this.checker = opts.checker
    this.mainWindow = opts.mainWindow
    this.getCurrentVersion = opts.getCurrentVersion ?? (() => app.getVersion())
    this.ipc = new IpcRegistry(opts.senderPolicy)
    this.registerIpc()
    this.startPeriodicCheck(opts.checkInterval ?? 60 * 60 * 1000, opts.initialDelay ?? 5000)
  }

  private registerIpc(): void {
    this.ipc
      .handle(UpdateChannel.Check, async () => this.check())
      .handle(UpdateChannel.Download, async () => this.download())
      .handle(UpdateChannel.Install, async () => this.install())
  }

  async check(): Promise<{ hasUpdate: boolean; info?: UpdateInfo }> {
    try {
      const currentVersion = this.getCurrentVersion()
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
        this.mainWindow.webContents.send(UpdateChannel.DownloadProgress, { percent })
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

  /**
   * Tear down timers + IPC handlers. Returns a Promise so callers that need
   * a settled cleanup (e.g. workbench registry shutdown, the unit-test
   * lifecycle suite) can await it; calling without await is also safe since
   * the timer clears + handler removals are scheduled synchronously.
   */
  dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    return this.ipc.dispose()
  }

  private startPeriodicCheck(interval: number, initialDelay: number): void {
    this.initialTimer = setTimeout(() => void this.checkAndNotify(), initialDelay)
    this.timer = setInterval(() => void this.checkAndNotify(), interval)
  }

  private async checkAndNotify(): Promise<void> {
    const result = await this.check()
    if (result.hasUpdate && result.info) {
      this.mainWindow.webContents.send(UpdateChannel.Available, result.info)
    }
  }
}
