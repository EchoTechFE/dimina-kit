import { describe, expect, it } from 'vitest'
import {
  buildRenderHostDocumentUrl,
  DMB_PAGEFRAME_DOC_NAME,
  DMB_SDK_PREFIX,
} from './render-host-url.js'

const baseOptions = {
  bridgeId: 'b1',
  appId: 'wx1234567890',
  root: 'main',
  pagePath: 'pages/home/home',
}

describe('DMB_SDK_PREFIX', () => {
  it('reserves a dedicated subtree so SDK assets never collide with package paths', () => {
    // Mini-app package resources live at the `dmb-resource` origin root
    // (`/<appId>/<root>/…`). Hosting the SDK under its own prefix is what keeps
    // the two namespaces disjoint, mirroring Android's `/jssdk/`.
    expect(DMB_SDK_PREFIX).toBe('/__sdk__/')
  })
})

describe('DMB_PAGEFRAME_DOC_NAME re-export', () => {
  // Smoke test: this file only re-exports from ../../../shared/dmb-resource-url.js;
  // the shared module's own test file (src/shared/dmb-resource-url.test.ts) owns
  // the full behavioral contract for this constant and for
  // buildRenderHostDocumentUrl's path/query shape.
  it('re-exports the reserved frame-document name used to build per-page document URLs', () => {
    expect(DMB_PAGEFRAME_DOC_NAME).toBe('__frame__.html')
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

  // Modifying this test: it used to assert the document always lives at the
  // fixed `/__sdk__/render-host/pageFrame.html` path, regardless of which page
  // was being rendered. That fixed shape is exactly what this fix replaces —
  // the document now encodes appId/root/page-directory, directly under the
  // page's own package path (no separate virtual prefix — the reserved
  // `__frame__.html` name is what identifies it), so a hand-written relative
  // package path resolves correctly (see the "core invariant" tests in
  // ../../../shared/dmb-resource-url.test.ts).
  it('hosts the frame document under <appId>/<root>/<pageDir>, not the fixed SDK subtree', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(url.pathname).toBe('/wx1234567890/main/pages/home/__frame__.html')
    expect(url.pathname.endsWith(`/${DMB_PAGEFRAME_DOC_NAME}`)).toBe(true)
  })

  it('passes the spawn identity through the query string', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(url.searchParams.get('bridgeId')).toBe('b1')
    expect(url.searchParams.get('appId')).toBe('wx1234567890')
    expect(url.searchParams.get('root')).toBe('main')
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
  // the invariants below break if the document's directory depth ever drifts
  // from the page's directory depth inside the package.
  const documentUrl = buildRenderHostDocumentUrl(baseOptions)

  // Modifying this test: it used to assert the relative reference resolved to
  // `dmb-resource://b1/static/avatars/x.png` — missing the appId/root prefix
  // entirely. That was the bug this fix addresses (relative resolution against
  // a document with no package-relative directory info can never land on the
  // correct in-package path).
  it('resolves a relative package image into the package root, not the origin root', () => {
    const resolved = new URL('../../static/avatars/x.png', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/wx1234567890/main/static/avatars/x.png')
    expect(resolved.protocol).toBe('dmb-resource:')
  })

  it('resolves a root-absolute package path at the origin root', () => {
    const resolved = new URL('/wx1234567890/main/static/x.png', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/wx1234567890/main/static/x.png')
  })

  // Modifying this test: it used to reach a sibling SDK module via a
  // page-relative reference ('../native-host/…'), which only worked because
  // the document used to live at the fixed `/__sdk__/render-host/pageFrame.html`.
  // Now the document's directory tracks the *page's* directory inside the
  // package, which varies per page, so a page-relative reference no longer
  // lands in the SDK subtree. Sibling SDK assets must be referenced with a
  // root-absolute `/__sdk__/…` path instead, which resolves correctly
  // regardless of page depth.
  it('keeps SDK modules reachable via a root-absolute /__sdk__/… reference', () => {
    const resolved = new URL('/__sdk__/native-host/render/render.js', documentUrl)

    expect(resolved.toString()).toBe('dmb-resource://b1/__sdk__/native-host/render/render.js')
    expect(resolved.pathname.startsWith(DMB_SDK_PREFIX)).toBe(true)
  })

  it('never resolves package or SDK resources to a file URL', () => {
    for (const relative of [
      '../../static/avatars/x.png',
      '/wx1234567890/main/static/x.png',
      './logo.png',
      '/__sdk__/native-host/render/render.js',
    ]) {
      expect(new URL(relative, documentUrl).protocol).toBe('dmb-resource:')
    }
  })
})
