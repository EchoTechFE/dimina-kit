import { describe, expect, it } from 'vitest'
import {
  buildRenderHostDocumentUrl,
  DMB_PAGEFRAME_DOC_NAME,
  DMB_SDK_PREFIX,
  type RenderHostDocumentUrlOptions,
} from './dmb-resource-url.js'

const baseOptions: RenderHostDocumentUrlOptions = {
  bridgeId: 'b1',
  appId: 'wx1',
  root: 'main',
  pagePath: 'pages/home/home',
}

describe('DMB_SDK_PREFIX', () => {
  it('stays the fixed SDK subtree prefix', () => {
    expect(DMB_SDK_PREFIX).toBe('/__sdk__/')
  })
})

describe('DMB_PAGEFRAME_DOC_NAME', () => {
  it('names the frame document distinctly from any real package file', () => {
    // Double-underscore, matching DMB_SDK_PREFIX's convention — the document
    // lives directly under the page's own package path with no separate
    // virtual prefix, so this reserved name is the only thing that keeps it
    // from colliding with a real compiled package file.
    expect(DMB_PAGEFRAME_DOC_NAME).toBe('__frame__.html')
  })
})

describe('buildRenderHostDocumentUrl path shape', () => {
  it('encodes appId/root/page-directory into the path, dropping the page filename', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    // pagePath 'pages/home/home': the last segment 'home' is the page filename
    // and is dropped, leaving the directory 'pages/home'. No separate virtual
    // prefix — this looks like a real package path with a reserved filename.
    expect(url.pathname).toBe('/wx1/main/pages/home/__frame__.html')
  })

  it('omits the directory segment entirely when the page sits at the package root', () => {
    const url = new URL(buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'index' }))

    // A single-segment pagePath has no directory part; the path must not gain
    // a spurious extra '/' between root and the frame document name.
    expect(url.pathname).toBe('/wx1/main/__frame__.html')
  })

  it('joins a deeper page directory with the same "/" separators', () => {
    const url = new URL(buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'pages/a/b/index' }))

    expect(url.pathname).toBe('/wx1/main/pages/a/b/__frame__.html')
  })

  it('always ends with the reserved frame document name', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(url.pathname.endsWith(`/${DMB_PAGEFRAME_DOC_NAME}`)).toBe(true)
  })

  it('carries the bridgeId as hostname so the protocol handler resolves the session', () => {
    const url = new URL(buildRenderHostDocumentUrl({ ...baseOptions, bridgeId: 'bridge-42' }))

    expect(url.hostname).toBe('bridge-42')
  })
})

describe('buildRenderHostDocumentUrl segment validation', () => {
  it('rejects an appId containing a literal "/"', () => {
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, appId: 'a/b' })).toThrow()
  })

  it('rejects a root containing a literal "/"', () => {
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, root: 'a/b' })).toThrow()
  })

  it('rejects "." or ".." as appId/root', () => {
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, appId: '.' })).toThrow()
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, root: '..' })).toThrow()
  })

  it('rejects "." or ".." as a page-directory segment', () => {
    // `new URL(...)` silently normalizes these away, which would eat into
    // the document's apparent directory depth the same way an unchecked '/'
    // in appId/root would — same failure mode, so the same guard applies.
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'pages/../home' })).toThrow()
    expect(() => buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'pages/./home' })).toThrow()
  })
})

describe('buildRenderHostDocumentUrl query string', () => {
  it('passes the raw, unprocessed spawn identity through the query string', () => {
    const url = new URL(buildRenderHostDocumentUrl(baseOptions))

    expect(url.searchParams.get('bridgeId')).toBe('b1')
    expect(url.searchParams.get('appId')).toBe('wx1')
    expect(url.searchParams.get('root')).toBe('main')
    // The full original pagePath, not just the directory portion used in the path.
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

describe('buildRenderHostDocumentUrl special-character escaping', () => {
  it('produces a URL that re-parses cleanly when appId/root/pagePath contain spaces and non-ASCII text', () => {
    const opts: RenderHostDocumentUrlOptions = {
      bridgeId: 'b1',
      appId: 'wx app 应用',
      root: 'main root',
      pagePath: 'pages/首页/首页',
    }

    const raw = buildRenderHostDocumentUrl(opts)
    const url = new URL(raw)

    expect(url.hostname).toBe('b1')
    expect(url.pathname.endsWith(`/${DMB_PAGEFRAME_DOC_NAME}`)).toBe(true)
    // Space and non-ASCII characters must be percent-escaped, not left literal,
    // or the string would not be a valid URL to begin with.
    expect(url.pathname).not.toContain(' ')
  })

  it('round-trips the escaped path segments back to the original appId/root/directory', () => {
    const opts: RenderHostDocumentUrlOptions = {
      bridgeId: 'b1',
      appId: 'wx app 应用',
      root: 'main root',
      pagePath: 'pages/首页/首页',
    }

    const url = new URL(buildRenderHostDocumentUrl(opts))
    const segments = url.pathname.split('/').map(segment => decodeURIComponent(segment))

    expect(segments).toEqual(['', 'wx app 应用', 'main root', 'pages', '首页', '__frame__.html'])
  })
})

describe('core invariant: document directory depth matches the page package directory depth', () => {
  // This is the behavior the fix exists for: browsers resolve hand-written
  // relative references against the document URL using plain path arithmetic,
  // so the document's own directory depth must equal the page's directory
  // depth inside the mini-app package for a relative image reference to land
  // on the right file.

  it('a page at the package root (no directory) needs zero "../" to reach package resources', () => {
    const documentUrl = buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'index' })

    const resolved = new URL('static/avatars/x.png', documentUrl)

    expect(resolved.pathname).toBe('/wx1/main/static/avatars/x.png')
  })

  it('one directory level deep needs exactly one "../" to reach the package root', () => {
    // pagePath 'a/index' has directory 'a' — one segment, one level deep.
    const documentUrl = buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'a/index' })

    const resolved = new URL('../static/avatars/x.png', documentUrl)

    expect(resolved.pathname).toBe('/wx1/main/static/avatars/x.png')
  })

  it('two directory levels deep needs exactly two "../" to reach the package root', () => {
    // pagePath 'a/b/index' has directory 'a/b' — two segments, two levels deep.
    const documentUrl = buildRenderHostDocumentUrl({ ...baseOptions, pagePath: 'a/b/index' })

    const resolved = new URL('../../static/avatars/x.png', documentUrl)

    expect(resolved.pathname).toBe('/wx1/main/static/avatars/x.png')
  })

  it('the documented example (pagePath: pages/home/home) resolves to the package root, keeping the appId/root prefix', () => {
    const documentUrl = buildRenderHostDocumentUrl(baseOptions) // pagePath: 'pages/home/home'

    const resolved = new URL('../../static/avatars/x.png', documentUrl)

    expect(resolved.pathname).toBe('/wx1/main/static/avatars/x.png')
  })

  it('a root-absolute reference always lands at the origin root, regardless of page depth', () => {
    const documentUrl = buildRenderHostDocumentUrl(baseOptions)

    const resolved = new URL('/wx1/main/static/x.png', documentUrl)

    expect(resolved.pathname).toBe('/wx1/main/static/x.png')
  })
})
