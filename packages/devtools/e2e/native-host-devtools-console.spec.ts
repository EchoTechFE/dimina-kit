/**
 * E2E: under native-host, the right-panel Chrome "Console" DevTools must inspect
 * the SERVICE HOST (logic layer) — the hidden service-host window that loads
 * `…/service.html` — NOT the render-host page guest (`pageFrame.html`) and NOT
 * the DeviceShell shell document (`simulator.html`).
 *
 * Native-host topology + WHY service host:
 *   - The mini-app shell renders in a top-level "DeviceShell" WebContentsView
 *     that loads `…/simulator.html`.
 *   - Each PAGE is a nested render-host `<webview>` guest loading `…/pageFrame.html`
 *     (the VIEW / UI layer).
 *   - The mini-app's PAGE LOGIC — `console.log`, `wx.request`/fetch, the JS the
 *     developer wrote — runs in a hidden SERVICE HOST BrowserWindow that loads
 *     `…/service.html` (the LOGIC layer). That is where the Console/Network(fetch)/
 *     Sources signal lives; the render guest carries almost no console output.
 *
 * The CONTRACT pinned here: the right-panel DevTools host attaches to the
 * SERVICE HOST (service.html), so its Console shows the page's logic-layer logs.
 * It does NOT attach to a render-host guest (pageFrame.html) and does NOT attach
 * to the DeviceShell shell (simulator.html). The view layer's Elements equivalent
 * is served separately by the native WXML panel + render-guest highlight chain,
 * so a single DevTools front-end (pointed at the service host) is sufficient.
 *
 * RELIABLE OBSERVABLE SIGNAL — why NOT `isDevToolsOpened()`:
 *   In the headless `auto` e2e launch `webContents.isDevToolsOpened()` does NOT
 *   track the C4 attach at all (probed in Electron 41.2.1: the wc that HAS a
 *   DevTools host attached still reports `false`). The signal that ACTUALLY flips
 *   is the `webContents.devToolsWebContents` getter: the impl attaches via
 *   `serviceWc.setDevToolsWebContents(host)` + `openDevTools(...)`; after that the
 *   service wc's `devToolsWebContents` references the host (non-null). We assert
 *   this "has a DevTools host attached" fact, not `isDevToolsOpened()`.
 *
 * We can't read the Console panel content (closed shadow DOM), so we assert the
 * reachable, DISCRIMINATING structural facts in the MAIN process via
 * `electronApp.evaluate(({ webContents }) => …)`:
 *   (1) the service-host window (service.html) has a DevTools host attached
 *       (`devToolsWebContents != null`),
 *   (2) no render-host guest (pageFrame.html) has a DevTools host attached,
 *   (3) the simulator.html shell has NO DevTools host attached,
 *   (4) a `console.log` evaluated in the SERVICE HOST realm runs in the same
 *       webContents the DevTools host is attached to — i.e. the Console the user
 *       sees inspects the realm where page logic logs.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode (panel ripple → mass failures).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Drives
// the SAME automation handlers the SDK uses; under native-host App.callWxMethod
// routes through serviceWc.executeJavaScript('wx.*'). Mirrors the helper in
// native-host-render.spec.ts.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhdt1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhdt1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** Decode a render-host guest's page path out of its `…?pagePath=pages%2F…` URL. */
function guestPagePath(url: string): string {
  const m = url.match(/[?&]pagePath=([^&]+)/)
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

/** Current active mini-app page path (e.g. `pages/detail/detail`) via automation. */
async function activePagePath(): Promise<string> {
  const r = await wsCall<{ path?: string }>('App.getCurrentPage').catch(() => ({} as { path?: string }))
  return r.path ?? ''
}

// Structural snapshot of DevTools-HOST-ATTACH state across the relevant
// webContents, taken in the MAIN process. The reliable signal is
// `wc.devToolsWebContents != null` (a DevTools host is attached to that wc) —
// see the file header for why `isDevToolsOpened()` is unusable here.
interface DevToolsSnapshot {
  serviceFound: boolean
  serviceHasDevToolsHost: boolean
  shellFound: boolean
  shellHasDevToolsHost: boolean
  pageFrameCount: number
  pageFrameWithDevToolsHostCount: number
  pageFramePaths: string[]
}

async function devToolsSnapshot(app: ElectronApplication): Promise<DevToolsSnapshot> {
  const raw = await app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const hasHost = (wc: unknown): boolean =>
      (wc as { devToolsWebContents?: unknown }).devToolsWebContents != null
    // The service host's own DevTools front-end (the right-panel host wc) also
    // loads `devtools://…`; identify the service host strictly by `service.html`
    // so the front-end wc (which never matches that URL) can't be miscounted.
    const service = all.find((wc) => wc.getURL().includes('service.html'))
    const shell = all.find((wc) => wc.getURL().includes('simulator.html'))
    const guests = all.filter((wc) => wc.getURL().includes('pageFrame.html'))
    return {
      serviceFound: !!service,
      serviceHasDevToolsHost: service ? hasHost(service) : false,
      shellFound: !!shell,
      shellHasDevToolsHost: shell ? hasHost(shell) : false,
      guests: guests.map((wc) => ({ url: wc.getURL(), hasHost: hasHost(wc) })),
    }
  })
  return {
    serviceFound: raw.serviceFound,
    serviceHasDevToolsHost: raw.serviceHasDevToolsHost,
    shellFound: raw.shellFound,
    shellHasDevToolsHost: raw.shellHasDevToolsHost,
    pageFrameCount: raw.guests.length,
    pageFrameWithDevToolsHostCount: raw.guests.filter((g) => g.hasHost).length,
    pageFramePaths: raw.guests.map((g) => guestPagePath(g.url)),
  }
}

async function waitForPageFrameGuest(app: ElectronApplication, timeout = 30000): Promise<void> {
  await pollUntil(
    () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((wc) =>
        !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
      ),
    ),
    (present) => present === true,
    timeout,
    300,
  )
}

test.describe('native-host DevTools Console attaches to the service host (logic layer)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // The heavy native-host setup (Electron launch + project open + simulator
    // ready) lives in this hook; on a cold/slow machine it exceeds Playwright's
    // default 60s HOOK timeout (separate from the 180s per-test timeout above).
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-devtools-console-${process.pid}`,
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

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves; wait for it
    // and for at least one render-host guest (pageFrame.html) to exist.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    await waitForPageFrameGuest(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('the right-panel DevTools host is attached to the service host (service.html), not the render guest nor the shell', async () => {
    // The DevTools host may attach slightly after the service window settles;
    // poll for the contract (service host has a DevTools host attached).
    const snap = await pollUntil(
      () => devToolsSnapshot(electronApp),
      (s) => s.serviceFound && s.serviceHasDevToolsHost,
      30000,
      500,
    )

    // Preconditions: the service host, the shell, and at least one page guest all
    // exist (so the negative assertions below are discriminating, not vacuous).
    expect(snap.serviceFound, 'the service-host window (service.html) should exist').toBe(true)
    expect(snap.shellFound, 'the DeviceShell shell (simulator.html) should exist').toBe(true)
    expect(snap.pageFrameCount, 'at least one render-host guest (pageFrame.html) should exist').toBeGreaterThanOrEqual(1)

    // (1) The SERVICE HOST (logic layer) has a DevTools host attached — the
    //     Console inspects where the page's console.log / wx.request run.
    expect(
      snap.serviceHasDevToolsHost,
      'the service-host window (service.html) should have a DevTools host attached',
    ).toBe(true)

    // (2) No render-host page guest has a DevTools host attached — the right-panel
    //     DevTools follows the logic layer, not the view layer. (If the build
    //     wrongly attached to a guest, this count would be > 0.)
    expect(
      snap.pageFrameWithDevToolsHostCount,
      `no render-host guest (pageFrame.html) should have a DevTools host attached; guest paths=${JSON.stringify(snap.pageFramePaths)}`,
    ).toBe(0)

    // (3) The DeviceShell shell document must NOT have a DevTools host attached.
    expect(
      snap.shellHasDevToolsHost,
      'the DeviceShell shell (simulator.html) should NOT have a DevTools host attached',
    ).toBe(false)
  })

  test('a console.log evaluated in the service-host realm runs in the wc the DevTools host inspects', async () => {
    // Find the service-host wc in the main process, confirm it both (a) has a
    // DevTools host attached and (b) is the realm a page-style console.log
    // executes in — i.e. the inspected target IS the logic layer. This is the
    // user-visible promise: a page `console.log` shows up in the right-panel
    // DevTools Console because that Console inspects the service host.
    const probe = await electronApp.evaluate(async ({ webContents }) => {
      const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
      const service = all.find((wc) => wc.getURL().includes('service.html'))
      if (!service) return { ok: false as const, reason: 'no service host' }
      const hasHost = (service as { devToolsWebContents?: unknown }).devToolsWebContents != null
      // Emit a page-style console.log into the SERVICE HOST realm and read back a
      // realm-identifying token. `location.href` resolving to service.html proves
      // the realm we logged into is the service host the DevTools host inspects.
      try {
        const realmHref = String(await service.executeJavaScript(
          `(() => { console.log('[e2e] native-host page console probe'); return location.href })()`,
        ))
        return { ok: true as const, hasHost, realmHref }
      } catch (e) {
        return { ok: false as const, reason: 'executeJavaScript failed: ' + String((e as Error).message) }
      }
    })

    expect(probe.ok, `service-host probe failed: ${'reason' in probe ? probe.reason : ''}`).toBe(true)
    if (!probe.ok) return
    expect(
      probe.hasHost,
      'the service host the page console.log runs in should have the DevTools host attached',
    ).toBe(true)
    expect(
      probe.realmHref,
      'the realm the page console.log ran in should be the service host (service.html)',
    ).toContain('service.html')
  })

  test('after navigateTo, the DevTools host stays on the service host (logic layer is page-independent)', async () => {
    // Drive a real wx.navigateTo to a valid NON-tab page over the automation WS.
    // `pages/detail/detail` is in app.json `pages` but absent from `tabBar.list`.
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/pages/detail/detail' }] })

    // Confirm the active page actually switched to detail.
    const active = await pollUntil(
      () => activePagePath(),
      (p) => p.includes('pages/detail/detail'),
      20000,
      500,
    )
    expect(active, 'navigateTo should make pages/detail/detail the active page').toContain('pages/detail/detail')

    // The single service-host window backs every page of the app, so a page
    // navigation does NOT move the DevTools host: it stays attached to the
    // service host, and still no render guest / shell is inspected.
    const after = await pollUntil(
      () => devToolsSnapshot(electronApp),
      (s) => s.serviceFound && s.serviceHasDevToolsHost,
      30000,
      500,
    )

    expect(
      after.serviceHasDevToolsHost,
      'after navigateTo, the service host (service.html) should still have a DevTools host attached',
    ).toBe(true)
    expect(
      after.pageFrameWithDevToolsHostCount,
      `after navigateTo, no render-host guest should have a DevTools host attached; guest paths=${JSON.stringify(after.pageFramePaths)}`,
    ).toBe(0)
    expect(
      after.shellHasDevToolsHost,
      'after navigateTo, the DeviceShell shell (simulator.html) should still NOT have a DevTools host attached',
    ).toBe(false)
  })

  test('a render-layer (view) console.log is forwarded into the service host, [视图]-prefixed', async () => {
    // The right-panel DevTools is attached to the service host (asserted above),
    // so the SERVICE layer's console shows natively there. The view layer runs
    // in the render-host page guest (pageFrame.html) — a separate realm whose
    // console would otherwise be invisible in that DevTools. The ConsoleForwarder
    // mirrors render-layer entries INTO the service host's own console, prefixed
    // `[视图]`, so a single Console panel sees both layers (DevTools filter splits
    // them by prefix). This is the user-facing promise; we verify it end-to-end.
    //
    // Observable signal: a `console-message` listener installed on the service
    // host wc in the MAIN process captures the host's own console output —
    // including the forwarded `console.log('[视图]', …)` the forwarder injects via
    // executeJavaScript. We can't read the closed-shadow DevTools panel, but
    // `console-message` fires for exactly the same realm the panel inspects.
    const token = `view-probe-${Date.now()}`

    // Arm a capture buffer on the service host wc (main process). Stash on the wc
    // object so a later evaluate() can read it back. Records the FULL message
    // text so we can assert both the `[视图]` prefix and our unique token landed.
    const armed = await electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
      const service = all.find((wc) => wc.getURL().includes('service.html'))
      if (!service) return false
      const sink = service as unknown as {
        __viewForwardLog?: string[]
        __viewForwardArmed?: boolean
      }
      sink.__viewForwardLog = []
      if (!sink.__viewForwardArmed) {
        sink.__viewForwardArmed = true
        // Electron 41 may deliver console-message as either (event, details)
        // with `details.message`, or the legacy (event, level, message, …).
        // Mirror helpers.ts#installConsoleCollector and pull the message text
        // from whichever shape arrives. args[0] is always the event, never text.
        service.on('console-message', (...args: unknown[]) => {
          const a1 = args[1]
          let message: string
          if (a1 && typeof a1 === 'object' && 'message' in (a1 as object)) {
            message = String((a1 as { message?: unknown }).message ?? '')
          } else {
            message = String(args[2] ?? '')
          }
          sink.__viewForwardLog!.push(message)
        })
      }
      return true
    })
    expect(armed, 'service-host window (service.html) should exist to arm the capture').toBe(true)

    // Emit a console.log INSIDE the render-host page guest (pageFrame.html). This
    // hits the render-host preload's patched console.* → posts a source:'render'
    // consoleLog to main → bridge-router → ConsoleForwarder → service host. We
    // log a plain string arg so the forwarded service-side line is exactly
    // `[视图] <token>` and easy to match.
    await evalInWebContentsByUrl(
      electronApp,
      'pageFrame.html',
      `console.log(${JSON.stringify(token)}); true`,
    )

    // Poll the captured service-host console output for the forwarded line.
    const captured = await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
        const service = all.find((wc) => wc.getURL().includes('service.html'))
        const sink = service as unknown as { __viewForwardLog?: string[] }
        return sink?.__viewForwardLog ? [...sink.__viewForwardLog] : []
      }),
      (logs) => logs.some((l) => l.includes('[视图]') && l.includes(token)),
      20000,
      300,
    )

    const hit = captured.find((l) => l.includes('[视图]') && l.includes(token))
    expect(
      hit,
      `the render-layer console.log should reach the service host as a [视图]-prefixed line; captured=${JSON.stringify(captured)}`,
    ).toBeTruthy()
  })

  test('a service-layer console.log keeps native source attribution (logic.js), not the deleted preload wrapper', async () => {
    // Regression for the source-attribution bug: the service host's console.* used
    // to be monkeypatched by a preload wrapper, so the embedded Chrome DevTools
    // mis-attributed EVERY service-layer log's source to the wrapper (preload.cjs)
    // instead of the developer's code. The fix removes the wrapper and captures
    // service-layer logs in the MAIN process via CDP `Runtime.consoleAPICalled`
    // (services/service-console), which preserves native source attribution.
    //
    // service-console already `debugger.attach('1.3')`-es the service host wc and
    // listens for `Runtime.consoleAPICalled`. We don't attach/detach our own
    // session (that would kill service-console's session); we APPEND a second
    // `message` listener on its already-attached debugger (appending is safe) and
    // collect each event's top-frame URL. The `//# sourceURL=…` directive sets the
    // realm script's URL, so a correctly-attributed log carries that URL on its
    // top call frame — and never `preload.cjs`.
    const token = `svc-source-probe-${Date.now()}`

    // Precondition: service-console has taken over the service host's debugger.
    // `isAttached()` true proves the in-process CDP capture is live (and that we
    // must NOT detach below).
    const attached = await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
        const svc = all.find((wc) => wc.getURL().includes('service.html'))
        if (!svc) return null
        try { return svc.debugger.isAttached() } catch { return false }
      }),
      (ok) => ok === true,
      30000,
      500,
    )
    expect(attached, 'service-console should have the debugger attached to the service host (service.html)').toBe(true)

    // Append a listener on the EXISTING (service-console-owned) debugger session
    // and stash collected top-frame URLs on the wc so a later evaluate() reads them
    // back. We tag the listener so afterwards we can remove EXACTLY ours via
    // removeListener — and we never detach.
    const armed = await electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
      const svc = all.find((wc) => wc.getURL().includes('service.html'))
      if (!svc) return false
      const sink = svc as unknown as {
        __svcSourceFrames?: string[]
        __svcSourceListener?: (...args: unknown[]) => void
      }
      sink.__svcSourceFrames = []
      const listener = (_event: unknown, method: string, params: unknown): void => {
        if (method !== 'Runtime.consoleAPICalled') return
        const p = params as { stackTrace?: { callFrames?: Array<{ url?: unknown }> } }
        const top = p.stackTrace?.callFrames?.[0]
        sink.__svcSourceFrames!.push(top ? String(top.url ?? '') : '')
      }
      sink.__svcSourceListener = listener
      svc.debugger.on('message', listener)
      return true
    })
    expect(armed, 'service-host window (service.html) should exist to append a consoleAPICalled listener').toBe(true)

    try {
      // Emit a console.log INTO the service realm carrying a `//# sourceURL`
      // directive, so the engine attributes the call frame to that script URL.
      // We drive it over the SAME already-attached debugger via `Runtime.evaluate`
      // so the call genuinely originates in the service realm (not via the wc's
      // own executeJavaScript pipeline).
      await electronApp.evaluate(async ({ webContents }, tok) => {
        const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
        const svc = all.find((wc) => wc.getURL().includes('service.html'))
        if (!svc) throw new Error('no service host')
        await svc.debugger.sendCommand('Runtime.evaluate', {
          expression: `console.log('${tok}');\n//# sourceURL=http://dimina.local/app/main/logic.js`,
        })
      }, token)

      // Poll the captured top-frame URLs: at least one consoleAPICalled must be
      // attributed to `logic.js`, and NONE may be attributed to `preload.cjs`
      // (the deleted wrapper would have re-attributed every entry there).
      const frames = await pollUntil(
        () => electronApp.evaluate(({ webContents }) => {
          const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
          const svc = all.find((wc) => wc.getURL().includes('service.html'))
          const sink = svc as unknown as { __svcSourceFrames?: string[] }
          return sink?.__svcSourceFrames ? [...sink.__svcSourceFrames] : []
        }),
        (urls) => urls.some((u) => u.includes('logic.js')),
        20000,
        300,
      )

      expect(
        frames.some((u) => u.includes('logic.js')),
        `a service-layer console.log should be source-attributed to logic.js; captured top frames=${JSON.stringify(frames)}`,
      ).toBe(true)
      expect(
        frames.some((u) => u.includes('preload.cjs')),
        `no service-layer console.log should be source-attributed to the deleted preload wrapper (preload.cjs); captured top frames=${JSON.stringify(frames)}`,
      ).toBe(false)
    } finally {
      // Remove ONLY our appended listener; never detach — detaching would tear
      // down service-console's own capture session.
      await electronApp.evaluate(({ webContents }) => {
        const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
        const svc = all.find((wc) => wc.getURL().includes('service.html'))
        const sink = svc as unknown as { __svcSourceListener?: (...args: unknown[]) => void }
        if (svc && sink?.__svcSourceListener) {
          try { svc.debugger.removeListener('message', sink.__svcSourceListener) } catch { /* gone */ }
          sink.__svcSourceListener = undefined
        }
      }).catch(() => {})
    }
  })

  test('a service-layer console.log still reaches the automation WS as App.logAdded', async () => {
    // No-regression for the console fan-out: deleting the preload monkeypatch and
    // switching to CDP capture must NOT drop service-layer logs from automation.
    // service-console emits each `consoleAPICalled` as a `source:'service'` entry
    // → console fan-out → automation rebroadcasts it as an `App.logAdded` event
    // (same WS shape native-host-render.spec.ts asserts for render-layer logs).
    const marker = `__e2e_svc_logadded_${Date.now()}__`
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const logs: Array<{ args?: unknown[] }> = []
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { method?: string; params?: { args?: unknown[] } }
        if (m.method === 'App.logAdded' && m.params) logs.push(m.params)
      } catch { /* ignore */ }
    })
    // Let the server register this client before emitting.
    await new Promise((r) => setTimeout(r, 300))

    try {
      // Fire a console.log directly in the SERVICE realm. A unique marker keeps
      // this distinct from the `logic.js` line test A injects (different token).
      await evalInWebContentsByUrl(
        electronApp,
        'service.html',
        `console.log(${JSON.stringify(marker)}); 1`,
      )

      const found = await pollUntil(
        async () => logs.some((p) => JSON.stringify(p.args ?? []).includes(marker)),
        (ok) => ok === true,
        15000,
        300,
      )
      expect(
        found,
        'a service-layer console.log should reach the automation WS via the CDP consoleAPICalled capture',
      ).toBe(true)
    } finally {
      ws.close()
    }
  })
})
