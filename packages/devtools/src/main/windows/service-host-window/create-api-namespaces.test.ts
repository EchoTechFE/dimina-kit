/**
 * Guards the apiNamespaces URL parameter contract on buildServiceHostSpawnUrl:
 * a non-empty array is encoded as a comma-separated query param so the
 * service-host preload knows which extra global namespace objects to install;
 * an empty or absent field must not produce the param.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getLocale: () => 'en-US',
    getPath: vi.fn(() => '/tmp/dimina-test'),
  },
  BrowserWindow: class {},
  protocol: {
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  },
}))

import { buildServiceHostSpawnUrl } from './create.js'
import type { ServiceHostWindowOptions } from './create.js'

const BASE_OPTS: ServiceHostWindowOptions = {
  bridgeId: 'bridge-1',
  appId: 'test-app',
  pagePath: 'pages/index/index',
  pkgRoot: '/tmp/pkg',
  resourceBaseUrl: 'http://127.0.0.1:8080/',
  root: 'main',
}

describe('buildServiceHostSpawnUrl — apiNamespaces query param', () => {
  it('encodes a non-empty apiNamespaces array as a comma-separated query param', () => {
    const url = new URL(
      buildServiceHostSpawnUrl(
        { ...BASE_OPTS, apiNamespaces: ['qd', 'mt'] } as unknown as ServiceHostWindowOptions,
      ),
    )
    expect(url.searchParams.get('apiNamespaces')).toBe('qd,mt')
  })

  it('omits the apiNamespaces param when the field is not provided', () => {
    const url = new URL(buildServiceHostSpawnUrl(BASE_OPTS))
    expect(url.searchParams.has('apiNamespaces')).toBe(false)
  })

  it('omits the apiNamespaces param when apiNamespaces is an empty array', () => {
    const url = new URL(
      buildServiceHostSpawnUrl(
        { ...BASE_OPTS, apiNamespaces: [] } as unknown as ServiceHostWindowOptions,
      ),
    )
    expect(url.searchParams.has('apiNamespaces')).toBe(false)
  })
})
