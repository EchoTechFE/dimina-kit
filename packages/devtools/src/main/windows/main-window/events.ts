import type { BrowserWindow, WebContentsView } from 'electron'
import { globalShortcut } from 'electron'
import type { WorkbenchContext } from '../../services/workbench-context.js'
import { DisposableRegistry, type Disposable, toDisposable } from '../../utils/disposable.js'

export interface MainWindowEventState {
  context?: WorkbenchContext
  onResize?: () => void
  onClose?: (event: Electron.Event) => void | Promise<void>
}

export function wireMainWindowEvents(
  win: BrowserWindow,
  state: MainWindowEventState = {},
): Disposable {
  const registry = new DisposableRegistry()
  const mainWebView = win.contentView.children[0] as WebContentsView | undefined

  const resizeMainWebView = () => {
    if (mainWebView) {
      const [w, h] = win.getContentSize()
      mainWebView.setBounds({ x: 0, y: 0, width: w, height: h })
    }
    state.onResize?.()
  }

  resizeMainWebView()
  win.on('resize', resizeMainWebView)
  registry.add(toDisposable(() => {
    win.removeListener('resize', resizeMainWebView)
  }))

  if (state.onClose) {
    const onCloseHandler = (event: Electron.Event) => {
      void state.onClose?.(event)
    }
    win.on('close', onCloseHandler)
    registry.add(toDisposable(() => {
      win.removeListener('close', onCloseHandler)
    }))
  }

  // DevTools shortcut: scoped to this main window so its disposal is tied
  // to ctx.registry. `unregisterAll()` in lifecycle remains as a process-exit
  // safety net.
  const devToolsAccelerator = 'CommandOrControl+Shift+I'
  const registered = globalShortcut.register(devToolsAccelerator, () => {
    win.webContents.openDevTools({ mode: 'detach' })
  })
  if (registered) {
    registry.add(toDisposable(() => {
      globalShortcut.unregister(devToolsAccelerator)
    }))
  }

  return registry
}
