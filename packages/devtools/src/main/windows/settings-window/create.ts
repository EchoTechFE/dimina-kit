import { BrowserWindow } from 'electron'
import path from 'path'
import { themeBg } from '../../utils/theme.js'

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
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  await win.loadFile(path.join(rendererDir, 'entries/workbench-settings/index.html'))
  return win
}
