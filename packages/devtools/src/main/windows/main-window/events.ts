import type { BrowserWindow, WebContentsView } from 'electron'
import type { WorkbenchContext } from '../../services/workbench-context.js'

export interface MainWindowEventState {
  context?: WorkbenchContext
  onResize?: () => void
  onClose?: (event: Electron.Event) => void | Promise<void>
}

export function wireMainWindowEvents(
  win: BrowserWindow,
  state: MainWindowEventState = {},
): void {
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

  if (state.onClose) {
    win.on('close', (event) => {
      void state.onClose?.(event)
    })
  }
}
