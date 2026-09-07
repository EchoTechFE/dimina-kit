import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
const sessions = vi.hoisted(() => new Map<string, object>())
vi.mock('electron', () => ({ session: { fromPartition: (partition: string) => {
  if (!sessions.has(partition)) sessions.set(partition, {})
  return sessions.get(partition)
} } }))
import { session } from 'electron'
import { miniappPartition } from '../views/miniapp-partition.js'
import { clearSimulatorServicewechatReferer, setSimulatorServicewechatReferer } from '../simulator/referer.js'
import { nativeRequestOptions } from './request-context.js'

afterEach(() => {
  for (const project of ['/project/a', '/project/b']) clearSimulatorServicewechatReferer('same-app', project)
  sessions.clear()
})

describe('native request execution context', () => {
  it('uses the original execution document and supports an invoking subframe override', () => {
    const source = { getURL: () => 'https://example.com/page/index.html', session: {} } as WebContents
    expect(nativeRequestOptions({ url: './api', baseUrl: 'https://untrusted.invalid/' }, source).baseUrl).toBe(source.getURL())
    expect(nativeRequestOptions({ url: '/api' }, source, 'https://example.com/frame/index.html').baseUrl).toBe('https://example.com/frame/index.html')
  })

  it('applies the authoritative Referer for each project partition without mutating caller headers', () => {
    const header = { ReFeReR: 'caller', 'x-test': 'yes' }
    for (const [project, version] of [['/project/a', 'develop'], ['/project/b', 'release']]) {
      setSimulatorServicewechatReferer('same-app', version, project)
    }
    for (const [project, version] of [['/project/a', 'develop'], ['/project/b', 'release']]) {
      const source = { getURL: () => 'https://example.com/', session: session.fromPartition(miniappPartition('same-app', project)) } as WebContents
      expect(nativeRequestOptions({ url: '/api', header }, source).header).toEqual({ referer: `https://servicewechat.com/same-app/${version}/page-frame.html`, 'x-test': 'yes' })
    }
    expect(header.ReFeReR).toBe('caller')
  })
})
