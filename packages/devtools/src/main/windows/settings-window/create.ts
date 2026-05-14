import { BrowserWindow } from 'electron'
import path from 'path'
import { mainPreloadPath } from '../../utils/paths.js'
import { themeBg } from '../../utils/theme.js'
import { applyNavigationHardening } from '../navigation-hardening.js'

export async function createSettingsWindow(
  parent: BrowserWindow | null | undefined,
  rendererDir: string,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 380,
    minHeight: 480,
    parent: parent ?? undefined,
    title: '开发工具设置',
    backgroundColor: themeBg(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
  })

  // Standalone settings window loads mainPreloadPath, so the same
  // navigation rules as the main window apply — see navigation-hardening.ts.
  applyNavigationHardening(win.webContents, rendererDir)

  await win.loadFile(path.join(rendererDir, 'entries/workbench-settings/index.html'))
  return win
}
