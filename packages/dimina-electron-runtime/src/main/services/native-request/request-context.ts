import type { WebContents } from 'electron'
import type { NativeRequestOptions } from './types.js'
import { getSimulatorServicewechatRefererForSession } from '../simulator/referer.js'

/** Both native entrypoints use the old execution document and session policy. */
export function nativeRequestOptions(params: Record<string, unknown>, source: Pick<WebContents, 'getURL' | 'session'>, documentUrl?: string): NativeRequestOptions {
  const forcedReferer = getSimulatorServicewechatRefererForSession(source.session)
  let header = params.header as Record<string, string> | undefined
  if (forcedReferer) {
    header = Object.fromEntries(Object.entries(header ?? {}).filter(([key]) => key.toLowerCase() !== 'referer'))
    header.referer = forcedReferer
  }
  return {
    url: typeof params.url === 'string' ? params.url : '',
    baseUrl: documentUrl || source.getURL(),
    data: params.data,
    header,
    timeout: typeof params.timeout === 'number' ? params.timeout : undefined,
    method: typeof params.method === 'string' ? params.method : undefined,
    dataType: typeof params.dataType === 'string' ? params.dataType : undefined,
    responseType: typeof params.responseType === 'string' ? params.responseType : undefined,
  }
}
