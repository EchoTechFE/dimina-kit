/**
 * Document URL for the Electron render host.
 *
 * Hosts pageFrame under a dedicated SDK subtree on the `dmb-resource` origin so
 * browser-relative package paths (`../../static/…`, `/<appId>/main/static/…`)
 * resolve against the package root — same shape as WeChat's `/__pageframe__/`
 * and Android's `/jssdk/` on a shared asset origin.
 */

/** dmb-resource origin subtree for runtime SDK assets (pageFrame, native-host). */
export const DMB_SDK_PREFIX = '/__sdk__/'

export interface RenderHostDocumentUrlOptions {
  bridgeId: string
  appId: string
  pagePath: string
  isTab?: boolean
  backgroundColor?: string
}

/**
 * Build the navigation URL for a render-host `<webview>`.
 * Hostname is the bridgeId so `protocol.handle('dmb-resource')` can resolve the AppSession.
 */
export function buildRenderHostDocumentUrl(opts: RenderHostDocumentUrlOptions): string {
  const url = new URL(`dmb-resource://${opts.bridgeId}${DMB_SDK_PREFIX}render-host/pageFrame.html`)
  url.searchParams.set('bridgeId', opts.bridgeId)
  url.searchParams.set('appId', opts.appId)
  url.searchParams.set('pagePath', opts.pagePath)
  if (opts.isTab) url.searchParams.set('isTab', '1')
  if (opts.backgroundColor) url.searchParams.set('bgColor', opts.backgroundColor)
  return url.toString()
}
