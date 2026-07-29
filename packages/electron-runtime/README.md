# dimina-electron-runtime

Embed a Dimina mini-app in an existing Electron application. The host owns
Electron's `app`, `BrowserWindow`, layout, and shutdown lifecycle; this package
owns compilation-session wiring, the mini-app bridge, and its `WebContentsView`.

```ts
import { app, BrowserWindow } from 'electron'
import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
} from 'dimina-electron-runtime'
import { openProject } from '@dimina-kit/devkit'

registerElectronRuntimeSchemes()
await app.whenReady()
const window = new BrowserWindow()
const runtime = createElectronRuntime({
  hostWindow: window,
  adapter: { openProject },
})
const session = await runtime.openProject({ projectPath: '/absolute/miniapp' })
window.contentView.addChildView(session.view)
session.setBounds({ x: 0, y: 0, width: 390, height: 844 })
await session.ready
```

Call `session.dispose()` before removing a project, and `runtime.dispose()` when
the host tears down the integration. One runtime may be active per Electron
process because its bridge uses process-global `ipcMain` channels.
