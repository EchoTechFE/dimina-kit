import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * Wave 3 R2 — HostToolbarControl gated narrow channel (MessagePort edition),
 * REAL APP. TDD-RED until R2 lands (`hostToolbar.onMessage/send` don't exist).
 *
 * Contract pinned here (the parts only a live Electron can prove):
 *  - bidirectional round trip page ⇄ main over the transferred MessagePort,
 *    including the PENDING-QUEUE path: the fixture's script `send()`s at
 *    script-run time, BEFORE the did-finish-load handshake can have completed
 *    (spike .repro/wave3-spike/RESULTS.md — without the preload queue the
 *    first message of every load is dropped);
 *  - `send()` returns false while no toolbar / no completed handshake (no
 *    queueing, no auto-created view) and flips true once the handshake lands;
 *  - `location.reload()`: main-side onMessage registrations survive WITHOUT
 *    re-registering (control-level registry re-attached to the new per-load
 *    port), and host→page works again on the new document;
 *  - no leak: the main window's main world has no `diminaHostToolbar` bridge
 *    (the session preload runs there too — guard zero-footprint, R2 surface).
 *
 * Mirrors host-toolbar.spec.ts: boot `host-toolbar-entry.js`, open the demo
 * project, then drive `instance.context.views.hostToolbar` from the MAIN
 * process via `electronApp.evaluate`.
 */

/** The R2 control surface as seen from electronApp.evaluate (main process). */
type ToolbarPortSurface = {
  loadFile(p: string): Promise<void>
  send(channel: string, payload: unknown): boolean
  onMessage(channel: string, handler: (payload: unknown) => void): { dispose(): void }
  webContents: { isDestroyed(): boolean; executeJavaScript(code: string): Promise<unknown> } | null
}
type E2eGlobals = {
  __e2eHostToolbarInstance: { context: { views: { hostToolbar: ToolbarPortSurface } } }
  __e2ePortPings?: unknown[]
}

test.describe('Host toolbar: gated MessagePort narrow channel (R2)', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-toolbar-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // The toolbar placeholder/anchor mounts with an open project; load toolbar
    // content only after this so the R1 height loop and the R2 handshake both
    // run against a mounted layout.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
  })

  test.afterAll(async () => {
    if (mainWindow && !mainWindow.isClosed()) {
      await closeProject(mainWindow).catch(() => {})
    }
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  /** Pings the host registry received so far (main-process array). */
  const hostPings = () =>
    electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      return (g.__e2ePortPings ?? []) as Array<{ from?: string; tag?: string }>
    })

  /** Run an expression in the toolbar page's main world (null if wc gone). */
  const inToolbarPage = (code: string) =>
    electronApp.evaluate(async (_electronMods, expr) => {
      const g = globalThis as unknown as E2eGlobals
      const wc = g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents
      if (!wc || wc.isDestroyed()) return null
      return wc.executeJavaScript(expr)
    }, code)

  test('page→host: pre-handshake send is gated false; the page ping (pending-queue path) arrives after ONE registration', async () => {
    // send() with no toolbar view at all: false, and it must not conjure one.
    const early = await electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      const toolbar = g.__e2eHostToolbarInstance.context.views.hostToolbar
      return { ok: toolbar.send('e2e:host', { too: 'early' }), created: toolbar.webContents !== null }
    })
    expect(early.ok).toBe(false)
    expect(early.created, 'send() must NOT auto-create the toolbar view').toBe(false)

    // Register the host-side handler ONCE for the whole spec (the reload test
    // below relies on this exact registration surviving).
    await electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      g.__e2ePortPings = []
      g.__e2eHostToolbarInstance.context.views.hostToolbar.onMessage('e2e:ping', (payload) => {
        g.__e2ePortPings!.push(payload)
      })
    })

    // The fixture script send()s at script-run time — before the handshake —
    // so this delivery proves the preload pending queue end to end.
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as E2eGlobals
      return g.__e2eHostToolbarInstance.context.views.hostToolbar.loadFile(file)
    }, path.join(FIXTURES, 'toolbar-port.html'))

    const pings = await pollUntil(hostPings, (v) => v.length >= 1, 30_000, 300)
    expect(pings[0]?.from).toBe('page')
    expect(pings[0]?.tag).toMatch(/^load-/)
  })

  test('host→page: send() flips true once the handshake lands and the page handler receives the envelope payload', async () => {
    // Poll send() itself: false until the per-load handshake completes, true
    // after. Each false attempt must deliver NOTHING (no queueing) — so the
    // page-side count below also bounds over-delivery.
    await pollUntil(
      () => electronApp.evaluate(() => {
        const g = globalThis as unknown as E2eGlobals
        return g.__e2eHostToolbarInstance.context.views.hostToolbar.send('e2e:host', { round: 1 })
      }),
      (ok) => ok === true,
      30_000,
      300,
    )

    const got = await pollUntil(
      () => inToolbarPage('Array.isArray(window.__hostMsgs) ? window.__hostMsgs : null'),
      (v) => Array.isArray(v) && v.length >= 1,
      15_000,
      300,
    ) as Array<{ round?: number }>
    expect(got[0]?.round).toBe(1)
  })

  test('location.reload(): the host registration survives un-re-registered; host→page works on the new document', async () => {
    const before = await hostPings()
    const beforeCount = before.length
    const beforeTag = before[before.length - 1]?.tag

    // Reload from inside the page (the spike's re-handshake scenario).
    await inToolbarPage('setTimeout(() => location.reload(), 0); null')

    // THE R2 ASSERTION (page→host): a NEW load's ping (fresh tag) reaches the
    // SAME handler registered in test 1 — control-level registry re-attached
    // to the new port. Per-port registration dies right here.
    const pings = await pollUntil(hostPings, (v) => v.length >= beforeCount + 1, 30_000, 300)
    const newTag = pings[pings.length - 1]?.tag
    expect(newTag).toMatch(/^load-/)
    expect(newTag, 'the post-reload ping must come from the NEW document').not.toBe(beforeTag)

    // host→page on the new document: send() gates false until the NEW
    // handshake lands, then the fresh page receives.
    await pollUntil(
      () => electronApp.evaluate(() => {
        const g = globalThis as unknown as E2eGlobals
        return g.__e2eHostToolbarInstance.context.views.hostToolbar.send('e2e:host', { round: 2 })
      }),
      (ok) => ok === true,
      30_000,
      300,
    )
    const got = await pollUntil(
      () => inToolbarPage('Array.isArray(window.__hostMsgs) ? window.__hostMsgs : null'),
      (v) => Array.isArray(v) && v.some((m) => (m as { round?: number }).round === 2),
      15_000,
      300,
    ) as Array<{ round?: number }>
    expect(got.some((m) => m?.round === 2)).toBe(true)
  })

  test('no leak: the main window main world has no diminaHostToolbar bridge', async () => {
    // The session preload executes in the main window too (spike item 4); the
    // guard must keep the R2 bridge out of every non-toolbar renderer. An
    // implementation that exposes unconditionally fails here (and trips the
    // /toolbar/i sweep in host-toolbar.spec.ts as well).
    const leak = await mainWindow.evaluate(
      () => typeof (window as unknown as { diminaHostToolbar?: unknown }).diminaHostToolbar,
    )
    expect(leak).toBe('undefined')
  })
})
