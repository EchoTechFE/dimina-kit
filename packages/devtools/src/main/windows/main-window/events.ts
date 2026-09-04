import type { WebContentsView } from 'electron'
import { BrowserWindow, globalShortcut } from 'electron'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../../services/workbench-context.js'
import { DisposableRegistry, type Disposable, toDisposable } from '@dimina-kit/electron-deck/main'

const DEVTOOLS_ACCELERATOR = 'CommandOrControl+Shift+I'
let devToolsShortcutHolders = 0

/**
 * Claims a share of the ONE process-wide DevTools accelerator. `globalShortcut`
 * is a process singleton: a per-window registration is refused for every window
 * after the first, which would give that first window the shortcut for the
 * whole app and kill it outright when that window closed. So the accelerator is
 * registered once, opens whichever window is focused when it is pressed, and is
 * released only when the last holder lets go — a later window can then claim it
 * again. `unregisterAll()` in lifecycle stays as a process-exit safety net.
 */
function acquireDevToolsShortcut(): Disposable {
  if (devToolsShortcutHolders === 0) {
    globalShortcut.register(DEVTOOLS_ACCELERATOR, () => {
      BrowserWindow.getFocusedWindow()?.webContents.openDevTools({ mode: 'detach' })
    })
  }
  devToolsShortcutHolders += 1
  return toDisposable(() => {
    devToolsShortcutHolders -= 1
    if (devToolsShortcutHolders === 0) globalShortcut.unregister(DEVTOOLS_ACCELERATOR)
  })
}

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

  registry.add(acquireDevToolsShortcut())

  return registry
}
