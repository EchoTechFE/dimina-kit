/**
 * WeChat-style page-frame referer for HTTPS requests proxied from the simulator session.
 * Format: https://servicewechat.com/{appId}/{version}/page-frame.html
 */

const DEFAULT_VERSION = 'develop'

let cachedRefererUrl: string | null = null

export function buildServicewechatPageFrameReferer(
  appId: string,
  version: string = DEFAULT_VERSION,
): string {
  return `https://servicewechat.com/${appId}/${version}/page-frame.html`
}

/** Called when a project session is active so protocol.handle can force Referer. */
export function setSimulatorServicewechatReferer(appId: string, version?: string): void {
  cachedRefererUrl = buildServicewechatPageFrameReferer(
    appId,
    version && version.length > 0 ? version : DEFAULT_VERSION,
  )
}

export function clearSimulatorServicewechatReferer(): void {
  cachedRefererUrl = null
}

export function getSimulatorServicewechatReferer(): string | null {
  return cachedRefererUrl
}
