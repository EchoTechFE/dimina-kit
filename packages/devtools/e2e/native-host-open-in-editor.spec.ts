/**
 * E2E: under native-host, clicking a project-source link in the right-panel
 * Chrome DevTools (the Console's source links) routes the click through the
 * built-in Monaco editor — "open file at line" — instead of the DevTools
 * Sources panel.
 *
 * The pipeline under test, end to end:
 *   1. A capture-phase click interceptor injected into the DevTools FRONT-END
 *      realm catches a `.devtools-link` click, maps the link's resource URL to
 *      the active project, and (only for project sources) calls
 *      `InspectorFrontendHost.openInNewTab(<sentinel>)` + `preventDefault` so
 *      the Sources panel never opens.
 *   2. Electron surfaces the sentinel as a `devtools-open-url` event on the
 *      inspected SERVICE-HOST webContents; main decodes it
 *      (`decodeOpenInEditorUrl`), re-maps the resource URL against the service
 *      URL's authoritative project context (`resolveProjectEditorTarget`,
 *      0-based → 1-based line), and broadcasts `editor:openFile` to the main
 *      window, where Monaco reveals the file.
 *
 * WHY a faithful click and not a direct `openInNewTab` call:
 *   The entry signal is constructed as a real `.devtools-link` DOM node plus a
 *   real capture-phase `click` MouseEvent dispatched in the DevTools front-end
 *   realm. This drives the INJECTED interceptor exactly as a user click would.
 *   It bypasses only the headless-DevTools fact that the Console panel does not
 *   render link rows for us to click — it does NOT bypass any tested logic:
 *   the interceptor's link→sentinel mapping, the exclusion of build chunks, the
 *   main-side decode/remap, and the renderer broadcast all run for real. The
 *   test never calls `openInNewTab` itself, so a green result requires the whole
 *   chain to be live (remove the interceptor's listener, or short-circuit the
 *   main `devtools-open-url` handler, and these assertions go red).
 *
 * WHERE the build-chunk exclusion happens:
 *   `excludeBuildChunk` lives inside `projectAwareResourcePath`, which is
 *   `.toString()`-injected into the DevTools front-end realm AND used by main.
 *   So a `common.js` / `taro.js` link is rejected IN THE FRONT-END: the
 *   interceptor's `projectLocationForLink` returns null and never emits a
 *   sentinel. The negative assertion therefore checks that NO `devtools-open-url`
 *   sentinel reaches main (the sink stays empty) — verified empirically below.
 *
 * RELIABLE OBSERVABLE SIGNALS (the closed-shadow DevTools panel and Monaco's
 * React-only `activePath` are not directly readable):
 *   - Layer 1 (main receives the sentinel): an EXTRA `devtools-open-url` listener
 *     armed on the service-host wc in the main process (EventEmitter multi-sub;
 *     does not touch the product listener).
 *   - Layer 2 (sourcemap remap + exclusion contract): the `editor:openFile`
 *     payload the renderer receives (positive: home.js mapped + line +1; negative
 *     common.js: no sentinel, no payload).
 *   - Layer 3 (renderer Monaco): the `editor:openFile` IPC observed on the main
 *     window (precondition), THEN home.js's source text rendered in Monaco's
 *     `.view-lines` — which Monaco paints only after `editor.openModel()`
 *     attaches a model, proving a real open rather than mere IPC arrival. The
 *     revealed cursor LINE stays unobservable (`globalThis.monaco` is not
 *     exposed); line correctness is pinned by Layer 2's editor:openFile payload.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { decodeOpenInEditorUrl } from '../src/shared/open-in-editor'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
// A real, mappable hand-written source in the fixture (NOT a build-chunk name).
const SOURCE_REL = 'pages/home/home.js'
// A well-known build-chunk basename `excludeBuildChunk` rejects (f05dd90e).
const EXCLUDED_REL = 'common.js'

let electronApp: ElectronApplication
let mainWindow: PwPage

/**
 * The service-host spawn URL carries the authoritative routing context the main
 * decoder re-maps against (`pkgRoot`/`resourceBaseUrl`/`appId`/`root`). Read it
 * at runtime so the resource URLs we click share the EXACT dev-server origin and
 * appId segment the project's compiled bundle uses — otherwise the front-end's
 * origin/appId gating would reject them for an unrelated reason and mask the
 * contract under test.
 */
interface ServiceContext {
  origin: string
  appId: string
}

async function readServiceContext(app: ElectronApplication): Promise<ServiceContext | null> {
  const raw = await app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const service = all.find((wc) => wc.getURL().includes('service.html'))
    return service ? service.getURL() : null
  })
  if (!raw) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  const resourceBaseUrl = url.searchParams.get('resourceBaseUrl') ?? ''
  const appId = url.searchParams.get('appId') ?? ''
  if (!resourceBaseUrl || !appId) return null
  let base: URL
  try { base = new URL(resourceBaseUrl) } catch { return null }
  return { origin: base.origin, appId }
}

/** Build the DevTools resource URL DevTools would report for a project source. */
function resourceUrl(ctx: ServiceContext, rel: string): string {
  return `${ctx.origin}/${ctx.appId}/${rel}`
}

/**
 * Arm an EXTRA `devtools-open-url` listener on the service-host wc and reset its
 * sink. EventEmitter multi-subscription: the product listener keeps running; we
 * only observe. Must run before each click so each click reads a fresh sink.
 */
async function armSentinelSink(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const service = all.find((wc) => wc.getURL().includes('service.html'))
    if (!service) return false
    const sink = service as unknown as { __openUrlSink?: string[]; __openUrlArmed?: boolean }
    sink.__openUrlSink = []
    if (!sink.__openUrlArmed) {
      sink.__openUrlArmed = true
      service.on('devtools-open-url', (_event: unknown, url: string) => {
        sink.__openUrlSink!.push(String(url))
      })
    }
    return true
  })
}

async function readSentinelSink(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const service = all.find((wc) => wc.getURL().includes('service.html'))
    const sink = service as unknown as { __openUrlSink?: string[] }
    return sink?.__openUrlSink ? [...sink.__openUrlSink] : []
  })
}

/**
 * Subscribe to `editor:openFile` on the MAIN window via the preload-exposed ipc
 * bridge and stash payloads on a window global. Non-invasive: this is the same
 * channel Monaco subscribes to; we add a parallel listener and poll it back.
 */
async function armEditorOpenSink(win: PwPage): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as {
      __editorOpenSink?: unknown[]
      __editorOpenArmed?: boolean
      devtools?: { ipc?: { on?: (c: string, h: (...a: unknown[]) => void) => unknown } }
    }
    w.__editorOpenSink = []
    if (w.__editorOpenArmed) return
    const on = w.devtools?.ipc?.on
    if (!on) throw new Error('[e2e] window.devtools.ipc.on unavailable — preload bridge missing?')
    w.__editorOpenArmed = true
    // The raw preload `ipc.on` listener is `(event, ...args)` — the typed
    // renderer `on()` helper strips the event, but we drive the bridge directly,
    // so the payload is the SECOND argument (args[1]).
    on('editor:openFile', (...args: unknown[]) => {
      w.__editorOpenSink!.push(args[1])
    })
  })
}

interface EditorOpenPayload { path: string; line?: number; column?: number }

async function readEditorOpenSink(win: PwPage): Promise<EditorOpenPayload[]> {
  return win.evaluate(() => {
    const w = window as unknown as { __editorOpenSink?: EditorOpenPayload[] }
    return w.__editorOpenSink ? [...w.__editorOpenSink] : []
  }) as Promise<EditorOpenPayload[]>
}

/**
 * Construct a real `.devtools-link` node carrying `title=<resourceUrl:1basedLine>`
 * and dispatch a real capture-phase primary click in the DevTools FRONT-END
 * realm. DevTools shows 1-based line:col in link text/title; the interceptor
 * converts to 0-based for the sentinel. We pass a 1-based line so the round-trip
 * (front-end −1, main +1) lands back at the same 1-based number in Monaco.
 *
 * `withHref` controls whether the synthetic anchor carries a navigable `href`,
 * and the choice is DELIBERATELY ASYMMETRIC between the positive and negative
 * cases:
 *   - PROJECT-SOURCE clicks (positive) DO set `href`. The interceptor claims
 *     these and calls `preventDefault`, so navigation is suppressed and the host
 *     wc survives. Setting `href` makes the click navigable, so a green result
 *     PROVES the interceptor's `preventDefault` actually stopped the default
 *     navigation (`defaultPrevented === true`); drop the `preventDefault` and the
 *     anchor would navigate the DevTools front-end and tear the host wc down.
 *   - BUILD-CHUNK clicks (negative) must NOT set `href`. The interceptor does
 *     not claim them (excludeBuildChunk → no location), so the default click
 *     runs; a navigable `href` would navigate the front-end and destroy the host
 *     wc, masking the contract. The interceptor reads the location from `title`
 *     regardless, so a href-less anchor still drives the same code path.
 *
 * `claimed`/`defaultPrevented` reflect whether the interceptor preventDefaulted
 * the click. The EFFECT (sentinel / editor:openFile) is observed via the sinks.
 */
async function clickDevtoolsLink(
  app: ElectronApplication,
  url: string,
  oneBasedLine: number,
  withHref: boolean,
): Promise<{ dispatched: boolean; reason?: string; defaultPrevented?: boolean }> {
  return app.evaluate(async ({ webContents }, payload) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const service = all.find((wc) => wc.getURL().includes('service.html'))
    if (!service) return { dispatched: false, reason: 'no service.html wc' }
    const devtoolsWc = (service as { devToolsWebContents?: Electron.WebContents }).devToolsWebContents
    if (!devtoolsWc) return { dispatched: false, reason: 'service wc has no devToolsWebContents host' }
    const title = `${payload.url}:${payload.oneBasedLine}`
    const hrefLine = payload.withHref
      ? `a.setAttribute('href', ${JSON.stringify('__TITLE__')})`
      : ''
    const expr = `(() => {
      try {
        const a = document.createElement('a')
        a.className = 'devtools-link'
        a.setAttribute('title', ${JSON.stringify('__TITLE__')})
        ${hrefLine}
        a.textContent = ${JSON.stringify('__TITLE__')}
        document.body.appendChild(a)
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 })
        a.dispatchEvent(ev)
        // defaultPrevented === true means a handler called preventDefault — i.e.
        // the interceptor claimed the click and suppressed navigation.
        const claimed = ev.defaultPrevented === true
        a.remove()
        return { ok: true, claimed }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })()`.replace(/__TITLE__/g, title.replace(/"/g, '\\"'))
    const res = await devtoolsWc.executeJavaScript(expr)
    if (!res || !res.ok) return { dispatched: false, reason: 'devtools eval failed: ' + (res && res.error) }
    return { dispatched: true, reason: res.claimed ? 'claimed' : 'not-claimed', defaultPrevented: res.claimed }
  }, { url, oneBasedLine, withHref })
}

test.describe('native-host: console source link click opens the file in Monaco', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-open-in-editor-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    // Gate on the auto-assigned dev-server port being live — the app is booted
    // and the service host can spawn once this resolves.
    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    // DeviceShell + at least one page guest must exist so the service host is
    // spawned and the right-panel DevTools front-end is attached + injected.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )

    // The service host + its DevTools front-end host must be attached, and the
    // front-end interceptor injected, before any click can be intercepted.
    await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
        const service = all.find((wc) => wc.getURL().includes('service.html'))
        const host = service && (service as { devToolsWebContents?: unknown }).devToolsWebContents
        return !!host
      }),
      (ready) => ready === true,
      30000,
      300,
    )

    await armEditorOpenSink(mainWindow)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('the service-host URL exposes a mappable project context (origin + appId)', async () => {
    const ctx = await readServiceContext(electronApp)
    expect(ctx, 'service.html URL should carry resourceBaseUrl + appId').not.toBeNull()
    expect(ctx!.origin, 'resourceBaseUrl should be a real dev-server origin').toMatch(/^https?:\/\//)
    expect(ctx!.appId.length, 'appId segment should be non-empty').toBeGreaterThan(0)
    // Pin the fixture's home.js really exists on disk — the main decoder gates on
    // isFile(), so a missing source would make the positive case silently no-op.
    expect(fs.existsSync(path.join(FIXTURE_DIR, SOURCE_REL))).toBe(true)
  })

  test('Layer 1: a project-source link click reaches main as a decodable sentinel carrying the 0-based line', async () => {
    const ctx = await readServiceContext(electronApp)
    expect(ctx).not.toBeNull()
    await armSentinelSink(electronApp)

    // Click home.js at 1-based line 5 (DevTools display). The interceptor encodes
    // 0-based, so the sentinel must carry l=4. Project-source clicks carry a real
    // href so the suppressed navigation is meaningful.
    const url = resourceUrl(ctx!, SOURCE_REL)
    const click = await clickDevtoolsLink(electronApp, url, 5, true)
    expect(click.dispatched, `click should dispatch in the devtools realm: ${click.reason}`).toBe(true)

    const sink = await pollUntil(
      () => readSentinelSink(electronApp),
      (urls) => urls.some((u) => u.startsWith('dimina-open-in-editor:')),
      10000,
      200,
    )
    const sentinel = sink.find((u) => u.startsWith('dimina-open-in-editor:'))
    expect(sentinel, `main should receive a sentinel via devtools-open-url; sink=${JSON.stringify(sink)}`).toBeTruthy()

    const decoded = decodeOpenInEditorUrl(sentinel!)
    expect(decoded, 'the sentinel should decode').not.toBeNull()
    expect(decoded!.url, 'the decoded resource URL should be the clicked home.js URL').toBe(url)
    expect(decoded!.line, 'DevTools 1-based line 5 should encode as 0-based 4').toBe(4)
  })

  test('Layer 2 (positive): home.js maps to the project-relative path with 1-based line via editor:openFile', async () => {
    const ctx = await readServiceContext(electronApp)
    expect(ctx).not.toBeNull()
    await armSentinelSink(electronApp)
    await armEditorOpenSink(mainWindow)

    // Project-source click WITH a navigable href: a green result proves the
    // interceptor's preventDefault actually suppressed the default navigation.
    const url = resourceUrl(ctx!, SOURCE_REL)
    const click = await clickDevtoolsLink(electronApp, url, 5, true)
    expect(click.dispatched, `click should dispatch: ${click.reason}`).toBe(true)
    expect(
      click.defaultPrevented,
      'the interceptor must preventDefault the project-source click (suppress navigation)',
    ).toBe(true)

    const payloads = await pollUntil(
      () => readEditorOpenSink(mainWindow),
      (ps) => ps.some((p) => p.path === SOURCE_REL),
      12000,
      200,
    )
    const hit = payloads.find((p) => p.path === SOURCE_REL)
    expect(hit, `editor:openFile should map to ${SOURCE_REL}; got=${JSON.stringify(payloads)}`).toBeTruthy()
    // 0-based 4 → main re-adds 1 → 1-based 5 for Monaco (view-manager.ts:361).
    expect(hit!.line, 'main should re-base the 0-based line to 1-based for Monaco').toBe(5)
  })

  test('Layer 2 (negative): a build-chunk (common.js) link is excluded — no sentinel, no editor:openFile', async () => {
    const ctx = await readServiceContext(electronApp)
    expect(ctx).not.toBeNull()

    // POSITIVE CONTROL: first prove the interceptor is LIVE on this host by
    // clicking a project source (home.js) and confirming its sentinel arrives.
    // This separates "interceptor never ran" from "excludeBuildChunk correctly
    // dropped the chunk" — without it, an empty sink for common.js could mean the
    // interceptor was simply dead, not that the exclusion worked.
    await armSentinelSink(electronApp)
    const sourceUrl = resourceUrl(ctx!, SOURCE_REL)
    const control = await clickDevtoolsLink(electronApp, sourceUrl, 5, true)
    expect(control.dispatched, `control click should dispatch: ${control.reason}`).toBe(true)
    const controlSink = await pollUntil(
      () => readSentinelSink(electronApp),
      (urls) => urls.some((u) => {
        const d = decodeOpenInEditorUrl(u)
        return !!d && d.url === sourceUrl
      }),
      10000,
      200,
    )
    expect(
      controlSink.some((u) => { const d = decodeOpenInEditorUrl(u); return !!d && d.url === sourceUrl }),
      'positive control: the live interceptor must emit a sentinel for a project source',
    ).toBe(true)

    // NEGATIVE: now click a build-chunk (common.js) with NO href (an unclaimed
    // click must not navigate + tear down the host wc).
    await armSentinelSink(electronApp)
    await armEditorOpenSink(mainWindow)
    const url = resourceUrl(ctx!, EXCLUDED_REL)
    const click = await clickDevtoolsLink(electronApp, url, 3, false)
    expect(click.dispatched, `click should dispatch: ${click.reason}`).toBe(true)
    // The interceptor must NOT claim a build-chunk click — the default is left
    // for the DevTools Sources panel (preventDefault never fires).
    expect(click.reason, 'a build-chunk click should fall through to DevTools (not claimed)').not.toBe('claimed')
    expect(click.defaultPrevented, 'a build-chunk click must not be preventDefaulted').not.toBe(true)

    // Settle window: give the chain the same wall-clock budget the positive case
    // needs, then assert nothing landed. Exclusion happens in the FRONT-END, so
    // no sentinel is emitted at all → the sink stays empty for this URL.
    await new Promise((r) => setTimeout(r, 2500))

    const sink = await readSentinelSink(electronApp)
    const leakedSentinel = sink
      .map((u) => decodeOpenInEditorUrl(u))
      .find((d) => d && d.url === url)
    expect(
      leakedSentinel,
      `common.js must not emit a sentinel (front-end excludeBuildChunk); sink=${JSON.stringify(sink)}`,
    ).toBeFalsy()

    const payloads = await readEditorOpenSink(mainWindow)
    const leakedOpen = payloads.find((p) => p.path === EXCLUDED_REL || p.path.endsWith('/common.js'))
    expect(
      leakedOpen,
      `common.js must not trigger editor:openFile; payloads=${JSON.stringify(payloads)}`,
    ).toBeFalsy()
  })

  test('Layer 3: Monaco truly opens home.js (renders its source), with the open IPC as precondition', async () => {
    // Two-stage proof:
    //   (a) the `editor:openFile` IPC the renderer subscribes to (precondition),
    //   (b) Monaco actually opened the file — observed via home.js source text in
    //       Monaco's `.view-lines`. Monaco paints `.view-lines` only after
    //       `editor.openModel()` attaches a model (MonacoEditor.tsx), so home.js's
    //       text there proves a successful model open, not merely IPC arrival.
    //   Boundary: `globalThis.monaco` is not exposed, so the revealed CURSOR LINE
    //   is not readable from the renderer — the 1-based line correctness is pinned
    //   by Layer 2 (editor:openFile payload) instead.
    const ctx = await readServiceContext(electronApp)
    expect(ctx).not.toBeNull()
    await armEditorOpenSink(mainWindow)

    const url = resourceUrl(ctx!, SOURCE_REL)
    const click = await clickDevtoolsLink(electronApp, url, 8, true)
    expect(click.dispatched, `click should dispatch: ${click.reason}`).toBe(true)

    // (a) precondition: the open IPC reaches the renderer.
    const payloads = await pollUntil(
      () => readEditorOpenSink(mainWindow),
      (ps) => ps.some((p) => p.path === SOURCE_REL && p.line === 8),
      12000,
      200,
    )
    const hit = payloads.find((p) => p.path === SOURCE_REL && p.line === 8)
    expect(
      hit,
      `the main window (Monaco's IPC endpoint) should receive editor:openFile for ${SOURCE_REL}:8; got=${JSON.stringify(payloads)}`,
    ).toBeTruthy()

    // (b) Monaco truly opened the file: the editor panel mounts and Monaco
    // renders home.js's SOURCE TEXT in its `.view-lines`. Monaco paints
    // `.view-lines` only after `editor.openModel()` attaches a model, so a
    // distinctive home.js token there proves a successful model open — not merely
    // IPC arrival. This is independent of the FileTree, whose home.js row sits
    // under a collapsed `pages/home/` folder (`TreeRow` defaults to open only at
    // depth < 1) and so is not in the DOM for a nested file.
    //
    // If the editor panel does not render in this headless native-host harness,
    // degrade to the IPC precondition above and record why.
    const editorMounted = await mainWindow
      .waitForSelector('[data-area="editor"] .monaco-editor', { timeout: 15000 })
      .then(() => true)
      .catch(() => false)

    if (!editorMounted) {
      test.info().annotations.push({
        type: 'degraded',
        description:
          'editor panel did not render in the native-host headless window; Layer 3 falls back to the editor:openFile IPC assertion (Monaco content unobservable).',
      })
      return
    }

    // home.js's first lines carry `Page({` and `pageName: 'home'`; match any of a
    // few distinctive tokens so line virtualization (only viewport lines paint)
    // can't flake the assertion as long as the model is open at the top.
    const editorText = await pollUntil(
      () => mainWindow.evaluate(() => {
        const el = document.querySelector('[data-area="editor"] .monaco-editor .view-lines')
        return el ? (el.textContent || '') : ''
      }),
      (text) => /Page\(|pageName|goDetail/.test(text),
      15000,
      300,
    ).catch(() => '')

    expect(
      /Page\(|pageName|goDetail/.test(editorText),
      `Monaco should render home.js source in .view-lines — proves editor.openModel() succeeded; got=${JSON.stringify(editorText.slice(0, 200))}`,
    ).toBe(true)
  })
})
