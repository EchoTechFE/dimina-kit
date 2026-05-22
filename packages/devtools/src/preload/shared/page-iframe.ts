/** Locate the active page's webview iframe — the last one in the simulator stack. */
export function getActivePageIframe(): HTMLIFrameElement | null {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('.dimina-native-webview__window')
  return iframes.length > 0 ? iframes[iframes.length - 1]! : null
}
