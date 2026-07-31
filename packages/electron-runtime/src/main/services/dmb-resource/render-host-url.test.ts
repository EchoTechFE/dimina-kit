import { describe, expect, it } from 'vitest'
import { buildRenderHostDocumentUrl, DMB_SDK_PREFIX } from './render-host-url.js'

const baseOptions = {
  bridgeId: 'b1',
  appId: 'wx1234567890',
  pagePath: 'pages/home/home',
}

describe('DMB_SDK_PREFIX', () => {
  it('reserves a dedicated subtree so SDK assets never collide with package paths', () => {
    // Mini-app package resources live at the `dmb-resource` origin root
    // (`/<appId>/<root>/…`). Hosting the SDK under its own prefix is what keeps
    // the two namespaces disjoint, mirroring WeChat's `/__pageframe__/` and
    // Android's `/jssdk/`.
    expect(DMB_SDK_PREFIX).toBe('/__sdk__/')
  })
})

describe('buildRenderHostDocumentUrl', () => {
  it('serves the render host over dmb-resource rather than file', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    // A `file:` document makes every relative package path resolve inside the
    // app bundle (app.asar), where mini-app assets do not exist.
    expect(url.protocol).toBe('dmb-resource:')
    expect(buildRenderHostDocumentUrl(baseOptions).startsWith('file:')).toBe(false)
  })

  it('carries the bridgeId as hostname so the protocol handler resolves the session', () => {
    const url = new URL(buildRenderHostDocumentUrl({ ...baseOptions, bridgeId: 'bridge-42' }))

    expect(url.hostname).toBe('bridge-42')
  })

  it('hosts pageFrame.html inside the SDK subtree, preserving the dist layout', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    // `render-host/` sits next to `native-host/` in the runtime dist, so the
    // document keeps that relative layout under the SDK prefix and existing
    // `../native-host/…` references stay valid.
    expect(url.pathname).toBe('/__sdk__/render-host/pageFrame.html')
    expect(url.pathname.startsWith(DMB_SDK_PREFIX)).toBe(true)
  })

  it('passes the spawn identity through the query string', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(url.searchParams.get('bridgeId')).toBe('b1')
    expect(url.searchParams.get('appId')).toBe('wx1234567890')
    expect(url.searchParams.get('pagePath')).toBe('pages/home/home')
  })

  it('flags tab pages with isTab=1, the form the simulator view parses', () => {
    const withTab = new URL(buildRenderHostDocumentUrl({ ...baseOptions, isTab: true }))
    const withoutTab = new URL(buildRenderHostDocumentUrl({ ...baseOptions, isTab: false }))

    expect(withTab.searchParams.get('isTab')).toBe('1')
    expect(withoutTab.searchParams.has('isTab')).toBe(false)
  })

  it('forwards the page background color as bgColor, the key the preload reads', () => {
    const withColor = new URL(
      buildRenderHostDocumentUrl({ ...baseOptions, backgroundColor: '#ff0000' }),
    )
    const withoutColor = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(withColor.searchParams.get('bgColor')).toBe('#ff0000')
    expect(withoutColor.searchParams.has('bgColor')).toBe(false)
  })
})

describe('resource resolution against the render host document', () => {
  // Every assertion resolves against the URL the builder actually produces, so
  // the invariants below break if the document ever moves off the SDK subtree.
  const documentUrl = buildRenderHostDocumentUrl(baseOptions)

  it('resolves a relative package image to the package root, not into the app bundle', () => {
    // A mini-app page at `pages/home/home` referencing `../../static/…` is the
    // exact shape that used to resolve inside app.asar under a `file:` document.
    const resolved = new URL('../../static/avatars/x.png', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/static/avatars/x.png')
    expect(resolved.protocol).toBe('dmb-resource:')
  })

  it('resolves a root-absolute package path at the origin root', () => {
    const resolved = new URL('/wx1234567890/main/static/x.png', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/wx1234567890/main/static/x.png')
  })

  it('keeps sibling SDK modules inside the SDK subtree', () => {
    const resolved = new URL('../native-host/render/render.js', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/__sdk__/native-host/render/render.js')
    expect(resolved.pathname.startsWith(DMB_SDK_PREFIX)).toBe(true)
  })

  it('never resolves package resources to a file URL', () => {
    for (const relative of [
      '../../static/avatars/x.png',
      '/wx1234567890/main/static/x.png',
      './logo.png',
      '../native-host/render/render.js',
    ]) {
      expect(new URL(relative, documentUrl).protocol).toBe('dmb-resource:')
    }
  })
})
