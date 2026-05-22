import type { RefObject } from 'react'

export type WebviewLike = HTMLElement & {
  getWebContentsId?: () => number
  getURL?: () => string
  reload?: () => void
  loadURL?: (url: string) => void
  send?: (channel: string, ...args: unknown[]) => void
}

export function asWebview(ref: RefObject<HTMLElement | null>): WebviewLike | null {
  return ref.current as WebviewLike | null
}

/**
 * Navigate `webview` to `url`, forcing a full reload.
 *
 * loadURL on a hash-only change is in-page navigation — the container does
 * not re-read the hash. So when the URL actually changes, loadURL and then
 * force a full reload; when it's already there, just reload.
 */
export function forceFullNavigate(webview: WebviewLike, url: string): void {
  const currentUrl = webview.getURL?.() ?? ''
  if (currentUrl === url) {
    webview.reload?.()
  }
  else {
    webview.loadURL?.(url)
    setTimeout(() => webview.reload?.(), 100)
  }
}
