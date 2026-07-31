import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleDmbResourceRequest } from './handle-request.js'
import {
  buildRenderHostDocumentUrl,
  DMB_PAGEFRAME_DOC_NAME,
} from './render-host-url.js'

const RESOURCE_BASE = 'http://127.0.0.1:5173/'
const SECRET = 'top-secret-outside-the-sdk-root'

let tmpRoot = ''
let sdkRoot = ''

/** Records every package fetch so tests can assert routing, not just payloads. */
interface PackageProbe {
  urls: string[]
  fetchPackage: (url: string) => Promise<Response>
}

function newPackageProbe(respond: (url: string) => Response = () => new Response('package-body', { status: 200 })): PackageProbe {
  const urls: string[] = []
  return {
    urls,
    fetchPackage: (url: string) => {
      urls.push(url)
      return Promise.resolve(respond(url))
    },
  }
}

function sessionFor(bases: Record<string, string>) {
  return (bridgeId: string): { resourceBaseUrl: string } | null => {
    const resourceBaseUrl = bases[bridgeId]
    return resourceBaseUrl ? { resourceBaseUrl } : null
  }
}

function request(
  requestUrl: string,
  overrides: {
    probe?: PackageProbe
    resolveSession?: (bridgeId: string) => { resourceBaseUrl: string } | null
  } = {},
): Promise<Response> {
  const probe = overrides.probe ?? newPackageProbe()
  return handleDmbResourceRequest({
    requestUrl,
    sdkRoot,
    resolveSession: overrides.resolveSession ?? sessionFor({ b1: RESOURCE_BASE }),
    fetchPackage: probe.fetchPackage,
  })
}

beforeAll(() => {
  // realpath keeps the containment check honest on macOS, where the temp dir is
  // a symlink (/var → /private/var) and a naive prefix compare would misfire.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-resource-')))
  sdkRoot = path.join(tmpRoot, 'dist')
  for (const [relativePath, content] of [
    ['render-host/pageFrame.html', '<!doctype html><title>page frame</title>'],
    ['render-host/pageFrame.css', '.page { color: red }'],
    ['native-host/render/render.js', 'export const render = 1'],
    ['native-host/container/logo.png', 'PNG-BYTES'],
  ] as const) {
    const target = path.join(sdkRoot, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  // Sits next to the SDK root: a successful traversal would disclose it.
  fs.mkdirSync(path.join(tmpRoot, 'outside'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'outside/secret.txt'), SECRET)
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('handleDmbResourceRequest session resolution', () => {
  it('returns 404 when the bridge session no longer exists', async () => {
    const probe = newPackageProbe()
    const response = await request('dmb-resource://gone/wx1/main/static/x.png', {
      probe,
      resolveSession: sessionFor({}),
    })

    expect(response.status).toBe(404)
    expect(probe.urls).toEqual([])
  })

  it('returns 404 for SDK paths of an unknown bridge', async () => {
    const response = await request('dmb-resource://gone/__sdk__/render-host/pageFrame.html', {
      resolveSession: sessionFor({}),
    })

    expect(response.status).toBe(404)
  })

  it('routes each bridge to its own session resource base', async () => {
    const probe = newPackageProbe()
    const resolveSession = sessionFor({
      b1: 'http://127.0.0.1:5173/',
      b2: 'http://127.0.0.1:6001/',
    })
    await request('dmb-resource://b1/wx1/main/static/x.png', { probe, resolveSession })
    await request('dmb-resource://b2/wx1/main/static/x.png', { probe, resolveSession })

    expect(probe.urls).toEqual([
      'http://127.0.0.1:5173/wx1/main/static/x.png',
      'http://127.0.0.1:6001/wx1/main/static/x.png',
    ])
  })
})

describe('handleDmbResourceRequest SDK subtree', () => {
  it('serves the render host document from the runtime dist', async () => {
    const response = await request('dmb-resource://b1/__sdk__/render-host/pageFrame.html')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>page frame</title>')
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('serves SDK modules that the document references relatively', async () => {
    const response = await request('dmb-resource://b1/__sdk__/native-host/render/render.js')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const render')
    expect(response.headers.get('content-type')).toMatch(/javascript/)
  })

  it('labels stylesheets and images with a usable content type', async () => {
    const css = await request('dmb-resource://b1/__sdk__/render-host/pageFrame.css')
    const png = await request('dmb-resource://b1/__sdk__/native-host/container/logo.png')

    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toMatch(/text\/css/)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toMatch(/image\/png/)
  })

  it('returns 404 for an SDK file that is not in the dist', async () => {
    const response = await request('dmb-resource://b1/__sdk__/render-host/missing.js')

    expect(response.status).toBe(404)
  })

  it('never proxies SDK paths to the package base', async () => {
    const probe = newPackageProbe()
    await request('dmb-resource://b1/__sdk__/render-host/pageFrame.html', { probe })

    expect(probe.urls).toEqual([])
  })
})

describe('handleDmbResourceRequest SDK containment', () => {
  // The URL parser folds away literal and single-encoded dot segments, so a
  // path still starting with `/__sdk__/` can only escape through encodings that
  // survive parsing. Containment must therefore be checked on the decoded,
  // resolved path rather than on the raw pathname.
  const escapes = [
    'dmb-resource://b1/__sdk__/..%2foutside%2fsecret.txt',
    'dmb-resource://b1/__sdk__/render-host/..%2f..%2foutside%2fsecret.txt',
  ]

  for (const requestUrl of escapes) {
    it(`rejects traversal out of the SDK root: ${requestUrl}`, async () => {
      const response = await request(requestUrl)

      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(SECRET)
    })
  }

  it('does not decode its way out of the SDK root twice', async () => {
    // A single decode of `%252e%252e` yields the literal segment `%2e%2e`,
    // which is not a dot segment and names no file. Only an implementation
    // that decodes twice would turn it back into `..`.
    const response = await request('dmb-resource://b1/__sdk__/%252e%252e/outside/secret.txt')

    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain(SECRET)
  })
})

describe('handleDmbResourceRequest package resources', () => {
  it('proxies a package path to the session resource base, keeping the query', async () => {
    const probe = newPackageProbe()
    const response = await request('dmb-resource://b1/wx1/main/static/avatars/x.png?v=2', { probe })

    expect(probe.urls).toEqual(['http://127.0.0.1:5173/wx1/main/static/avatars/x.png?v=2'])
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('package-body')
  })

  it('passes a package error response through instead of masking it', async () => {
    const probe = newPackageProbe(() => new Response('nope', { status: 404 }))
    const response = await request('dmb-resource://b1/wx1/main/static/missing.png', { probe })

    expect(response.status).toBe(404)
  })

  it('never reads package paths from the SDK root', async () => {
    // `render-host/pageFrame.html` exists under sdkRoot; without the `/__sdk__/`
    // prefix it is a package path and must go to the resource base, so a
    // mini-app page can never be shadowed by an SDK file of the same name.
    const probe = newPackageProbe()
    const response = await request('dmb-resource://b1/render-host/pageFrame.html', { probe })

    expect(probe.urls).toEqual(['http://127.0.0.1:5173/render-host/pageFrame.html'])
    expect(await response.text()).toBe('package-body')
  })
})

describe('render host document and its relative resources', () => {
  // Modifying this documentUrl: the builder now requires `root` (the page's
  // resource root inside the mini-app package), so the document encodes
  // appId/root/page-directory in its path instead of always living at the
  // fixed `/__sdk__/render-host/pageFrame.html`.
  const documentUrl = buildRenderHostDocumentUrl({
    bridgeId: 'b1',
    appId: 'wx1',
    root: 'main',
    pagePath: 'pages/home/home',
  })

  it('serves the document the render host is navigated to', async () => {
    const response = await request(documentUrl)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>page frame</title>')
  })

  // Modifying this test: it used to assert the relative reference resolved to
  // `http://127.0.0.1:5173/static/avatars/x.png` — missing the `wx1/main/`
  // package-path prefix entirely. That was the bug this fix addresses: the
  // fixed-path document gave the browser no way to know which package/root the
  // page belonged to, so a hand-written relative image reference could never
  // reach the right file. The fix makes the document's own directory depth
  // track the page's directory depth inside the package, so the same relative
  // reference now correctly lands under `wx1/main/`.
  it('fetches a relative page image from the mini-app package, with the appId/root prefix intact', async () => {
    // The browser resolves `../../static/…` against the document URL; this is
    // the path that reached app.asar while the document was a `file:` URL.
    const probe = newPackageProbe()
    const imageUrl = new URL('../../static/avatars/x.png', documentUrl).toString()
    const response = await request(imageUrl, { probe })

    expect(probe.urls).toEqual(['http://127.0.0.1:5173/wx1/main/static/avatars/x.png'])
    expect(response.status).toBe(200)
  })

  it('fetches a root-absolute page image from the mini-app package', async () => {
    const probe = newPackageProbe()
    const imageUrl = new URL('/wx1/main/static/x.png', documentUrl).toString()
    await request(imageUrl, { probe })

    expect(probe.urls).toEqual(['http://127.0.0.1:5173/wx1/main/static/x.png'])
  })

  // Modifying this test: it used to reach a sibling SDK module via a
  // page-relative reference ('../native-host/…'), which only worked because
  // the document used to live at the fixed `/__sdk__/render-host/pageFrame.html`.
  // Now the document's directory tracks the *page's* directory inside the
  // package (which varies per page), so a page-relative reference no longer
  // lands in the SDK subtree at all. Sibling SDK assets must be referenced
  // with a root-absolute `/__sdk__/…` path instead.
  it('loads an SDK module referenced by a root-absolute /__sdk__/… path, not from the package base', async () => {
    const probe = newPackageProbe()
    const moduleUrl = new URL('/__sdk__/native-host/render/render.js', documentUrl).toString()
    const response = await request(moduleUrl, { probe })

    expect(probe.urls).toEqual([])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const render')
  })
})

describe('handleDmbResourceRequest frame document (no separate virtual prefix)', () => {
  // The frame document lives directly under the page's own package path
  // (`/<appId>/<root>/<pageDir>/__frame__.html`, same shape a real package
  // resource would have) — the reserved `__frame__.html` name, not a prefix,
  // is what makes `handleDmbResourceRequest` serve it from the SDK dist
  // instead of proxying it. It still requires a resolved session first,
  // exactly like `/__sdk__/…` (see 'returns 404 for SDK paths of an unknown
  // bridge' above): `handleSpawn` registers the session and hands the URL to
  // the renderer before any navigation happens, so requiring one here isn't
  // circular, and it means a disposed/unknown bridge can't still load a live
  // document (keeps stale-guest detection meaningful).
  it('returns 404 for the frame document when the bridge session is unknown', async () => {
    const probe = newPackageProbe()
    const url = `dmb-resource://b1/wx1/main/pages/home/${DMB_PAGEFRAME_DOC_NAME}`
    const response = await request(url, { probe, resolveSession: sessionFor({}) })

    expect(response.status).toBe(404)
    expect(probe.urls).toEqual([])
  })

  it('serves the frame document once the bridge session is resolved', async () => {
    const probe = newPackageProbe()
    const url = `dmb-resource://b1/wx1/main/pages/home/${DMB_PAGEFRAME_DOC_NAME}`
    const response = await request(url, { probe })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>page frame</title>')
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(probe.urls).toEqual([])
  })

  it('serves identical content to /__sdk__/render-host/pageFrame.html regardless of appId/root/pageDir', async () => {
    const sdkResponse = await request('dmb-resource://b1/__sdk__/render-host/pageFrame.html')
    const pageframeA = await request(
      `dmb-resource://b1/wx1/main/pages/home/${DMB_PAGEFRAME_DOC_NAME}`,
    )
    const pageframeB = await request(
      `dmb-resource://b1/other-app/sub-root/pages/a/b/${DMB_PAGEFRAME_DOC_NAME}`,
    )

    const sdkBody = await sdkResponse.text()
    expect(await pageframeA.text()).toBe(sdkBody)
    expect(await pageframeB.text()).toBe(sdkBody)
    expect(pageframeA.headers.get('content-type')).toBe(sdkResponse.headers.get('content-type'))
    expect(pageframeB.headers.get('content-type')).toBe(sdkResponse.headers.get('content-type'))
  })

  it('serves the frame document when there is no page directory at all', async () => {
    // The page sits at the package root, so the path is just `/<appId>/<root>/__frame__.html`.
    const url = `dmb-resource://b1/wx1/main/${DMB_PAGEFRAME_DOC_NAME}`
    const response = await request(url)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>page frame</title>')
  })

  it('never proxies frame document requests to the package base', async () => {
    const probe = newPackageProbe()
    await request(
      `dmb-resource://b1/wx1/main/pages/home/${DMB_PAGEFRAME_DOC_NAME}`,
      { probe },
    )

    expect(probe.urls).toEqual([])
  })

  it('proxies a package path ending in a different filename normally, even under the same appId/root/pageDir', async () => {
    // Confirms the routing rule really is "last segment is __frame__.html",
    // not "any path under this appId/root/pageDir" — a sibling real file in
    // the exact same directory is an ordinary package resource.
    const probe = newPackageProbe()
    const response = await request(
      'dmb-resource://b1/wx1/main/pages/home/other-file.png',
      { probe },
    )

    expect(probe.urls).toEqual(['http://127.0.0.1:5173/wx1/main/pages/home/other-file.png'])
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('package-body')
  })
})
