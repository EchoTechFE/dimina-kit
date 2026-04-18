import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { openSettingsWindow } from '../app/launch.js'

export function installAppMenu(ctx: WorkbenchContext): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Dimina DevTools',
      submenu: [
        {
          label: '开发工具设置',
          click: () => {
            void openSettingsWindow(ctx).catch(() => {})
          },
        },
        { type: 'separator' },
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { role: 'window' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
