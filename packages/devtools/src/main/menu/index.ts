import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuContext } from '../../shared/types.js'

// The built-in menu consumes the narrow MenuContext, the same surface a host
// menuBuilder receives — proof that the hand-written contract covers the
// real internal consumption (settings entry + navigate-back).
export function installAppMenu(ctx: MenuContext): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Dimina DevTools',
      submenu: [
        {
          label: '开发工具设置',
          click: () => {
            void ctx.openSettings().catch(() => {})
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
      label: '项目',
      submenu: [
        {
          label: '打开项目',
          click: () => {
            ctx.notify.windowNavigateBack()
          },
        },
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
