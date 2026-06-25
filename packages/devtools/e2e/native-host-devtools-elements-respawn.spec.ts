/**
 * E2E regression guard: after a hot-reload respawn (source edit → watcher rebuild →
 * DeviceShell respawn), the embedded Chrome DevTools Elements panel must remain
 * pointed at the RENDER GUEST (pageFrame.html), not regress to the Service Host
 * (service.html / "Dimina Service Host").
 *
 * The elements-forward feature intercepts DOM./CSS./Overlay. commands in the
 * devtools:// front-end and re-routes them to the active render guest. After a
 * DeviceShell respawn the guest WebContents is replaced; if elements-forward fails
 * to re-prime the new guest, DOM.getDocument silently falls back to the service
 * host's own document — Elements shows an empty body or service-host script tags
 * instead of the page's real view tree.
 *
 * Invariant: for every hot-reload cycle, DOM.getDocument dispatched via the
 * (possibly wrapped) InspectorFrontendHost must return a root whose documentURL
 * contains "pageFrame.html" and does not contain "service.html",
 * "index.html?theme", or service-host system-info markers
 * ("statusBarHeight", '"theme":"light"').
 *
 * DOM probing for render-guest text uses the main-process webContents evaluation
 * pattern (screenshots cannot reach nested webview content).
 *
 * File hygiene: index.wxml is restored in `finally` after every cycle, and the
 * test waits for the restore-triggered rebuild to settle before the next cycle,
 * so a failure in one cycle never leaves a half-built output that bleeds into
 * subsequent specs.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  ipcInvoke,
  pollUntil,
  evalInWebContentsByUrl,
} from './helpers'
import { AutomationChannel, ProjectFsChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Boot / shutdown ──────────────────────────────────────────────────────

interface AppHandle { app: ElectronApplication; win: PwPage }

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-elements-respawn-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Move off-screen so the window doesn't interfere with other UI tests running
  // concurrently, but still wait for it to be shown so BrowserWindow is live.
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w && !w.isVisible()) {
      await new Promise<void>((resolve) => {
        w.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (w) {
      w.setPosition(-2000, -2000)
      w.blur()
    }
  })

  await pollUntil(
    () => ipcInvoke<number | null>(win, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  )

  await openProjectInUI(win, DEMO_APP_DIR, { waitMs: 30000 })

  return { app, win }
}

// ── Render-guest text probe (main-process evaluation) ────────────────────

/**
 * Concatenated visible text of every live render-host page guest.
 * Returns '' when no guest is ready yet — callers poll.
 */
async function readRenderText(app: ElectronApplication): Promise<string> {
  try {
    return await app.evaluate(async ({ webContents }) => {
      const frames = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      const texts: string[] = []
      for (const f of frames) {
        try {
          texts.push((await f.executeJavaScript('document.body.innerText')) as string)
        } catch {
          // guest navigating / not ready — skip
        }
      }
      return texts.join('\n')
    })
  } catch {
    return ''
  }
}

// ── DOM.getDocument probe (devtools:// front-end realm) ──────────────────

/**
 * Dispatch DOM.getDocument via InspectorFrontendHost.sendMessageToBackend
 * (the same path the Elements panel uses) and capture the response through a
 * one-shot window.DevToolsAPI.dispatchMessage interceptor.
 *
 * The interceptor is armed BEFORE the command is sent so the response never
 * races. Returns the full parsed CDP response object, or null on timeout /
 * missing DevTools API surface.
 */
async function getDocumentViaFrontend(
  app: ElectronApplication,
  timeoutMs = 4000,
): Promise<Record<string, unknown> | null> {
  return evalInWebContentsByUrl<Record<string, unknown> | null>(
    app,
    'devtools://',
    `(function() {
      return new Promise(function(resolve) {
        try {
          var IFH = globalThis.InspectorFrontendHost;
          var DTAPI = window.DevToolsAPI;
          if (!IFH || typeof IFH.sendMessageToBackend !== 'function') {
            return resolve(null);
          }
          if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') {
            return resolve(null);
          }

          var cmdId = Date.now();
          var settled = false;
          var origDispatch = DTAPI.dispatchMessage.bind(DTAPI);

          var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            window.DevToolsAPI.dispatchMessage = origDispatch;
            resolve(null);
          }, ${timeoutMs});

          DTAPI.dispatchMessage = function(messageStr) {
            try {
              var msg = (typeof messageStr === 'string') ? JSON.parse(messageStr) : messageStr;
              if (msg && msg.id === cmdId && !settled) {
                settled = true;
                clearTimeout(timer);
                window.DevToolsAPI.dispatchMessage = origDispatch;
                origDispatch(messageStr);
                resolve(msg);
                return;
              }
            } catch(_) {}
            origDispatch(messageStr);
          };

          IFH.sendMessageToBackend(JSON.stringify({
            id: cmdId,
            method: 'DOM.getDocument',
            params: { depth: 1 }
          }));
        } catch(e) {
          resolve(null);
        }
      });
    })()`,
  ).catch(() => null)
}

/**
 * Retry getDocumentViaFrontend until the response resolves and carries a root
 * node, or until the overall deadline passes. Returns the root node or null.
 *
 * Multiple retries tolerate: devtools:// front-end still loading after a
 * respawn, the elements-forward drain interval (~150ms), and the new render
 * guest still being primed by DOM.enable.
 */
async function pollGetDocumentRoot(
  app: ElectronApplication,
  totalTimeoutMs = 20000,
  perCallTimeoutMs = 4000,
): Promise<{ documentURL?: string; baseURL?: string } | null> {
  const deadline = Date.now() + totalTimeoutMs
  while (Date.now() < deadline) {
    const response = await getDocumentViaFrontend(app, perCallTimeoutMs)
    if (response && response.result) {
      const result = response.result as { root?: { documentURL?: string; baseURL?: string } }
      if (result.root) return result.root
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

// ── Rebuild-settle helper ─────────────────────────────────────────────────

/**
 * Wait for the restore-triggered watcher rebuild to start and finish so the
 * next cycle (or following spec) opens against a clean, fully-compiled output.
 * Best-effort — never throws.
 */
async function settleAfterRestore(win: PwPage): Promise<void> {
  const compileStatus = (): Promise<'done' | 'building' | 'unknown'> =>
    win.evaluate(() => {
      const els = document.querySelectorAll('[class*="truncate"]')
      for (const el of els) {
        const t = el.textContent || ''
        if (t.includes('完成')) return 'done'
        if (t.includes('编译') || t.includes('刷新') || t.includes('...') || t.includes('…')) return 'building'
      }
      return 'unknown'
    }) as Promise<'done' | 'building' | 'unknown'>

  const sawBuilding = await pollUntil(compileStatus, (s) => s === 'building', 5000, 200)
    .then((s) => s === 'building')
    .catch(() => false)

  if (sawBuilding) {
    await pollUntil(compileStatus, (s) => s === 'done', 12000, 300).catch(() => {})
  }
}

// ── Service-host latch detection ─────────────────────────────────────────

/**
 * Return true when the documentURL looks like a service-host or device-shell
 * document rather than a render guest.
 *
 * Patterns that indicate a latch to the wrong target:
 *   - "service.html"          — the Service Host WebContents
 *   - "index.html?theme"      — the DeviceShell / host toolbar
 *   - "statusBarHeight"       — encoded system-info in URL query
 *   - '"theme":"light"'       — encoded system-info in URL query
 */
function isServiceHostUrl(url: string): boolean {
  return (
    url.includes('service.html') ||
    url.includes('index.html?theme') ||
    url.includes('statusBarHeight') ||
    url.includes('"theme":"light"') ||
    url.includes('%22theme%22') // URL-encoded variant
  )
}

// ── Spec ─────────────────────────────────────────────────────────────────

test.describe('native-host Elements panel stays pointed at the render guest after hot-reload respawn', () => {
  test.describe.configure({ mode: 'serial' })
  // Each cycle drives a real watcher rebuild + DeviceShell respawn (~seconds), so
  // a few cycles plus the cold-boot need generous headroom under CI load.
  test.setTimeout(240_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    handle = await bootApp()
  })

  test.afterAll(async () => {
    if (!handle) return
    await handle.app.close().catch(() => {})
  })

  test('DOM.getDocument returns the render guest document across hot-reload respawn cycles', async () => {
    const { app, win } = handle!

    const wxmlPath = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.wxml')
    const original = fs.readFileSync(wxmlPath, 'utf8')

    // Baseline: render guest must be up and showing the expected page text before
    // we start mutating sources.
    await pollUntil(
      () => readRenderText(app),
      (t) => t.includes('DevTools 功能测试'),
      45000,
      1000,
    )

    // Verify the devtools:// front-end is reachable before cycling.
    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        app,
        'devtools://',
        '!!(globalThis.InspectorFrontendHost && window.DevToolsAPI)',
      ).catch(() => null),
      (ok) => ok === true,
      30000,
      500,
    )

    // Two respawns are enough to guard the regression: the bug latches Elements
    // onto the service host on the FIRST respawn. Kept low so the real per-cycle
    // rebuilds stay within the timeout under load.
    const CYCLES = 2

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const marker = `E2E_RESPAWN_${cycle}_${Date.now()}`
      const mutated = original.replace('DevTools 功能测试', `DevTools 功能测试 ${marker}`)

      // Sanity: substitution target must exist in the source.
      expect(
        mutated,
        `cycle ${cycle}: marker substitution target "DevTools 功能测试" must exist in index.wxml`,
      ).not.toBe(original)

      try {
        // Trigger hot reload via the same write path Monaco uses.
        await ipcInvoke(win, ProjectFsChannel.WriteFile, wxmlPath, mutated)

        // Wait for the render guest to respawn and show the new text — this is the
        // signal that the DeviceShell has been replaced with a new WebContents.
        await pollUntil(
          () => readRenderText(app),
          (t) => t.includes(marker),
          25000,
          800,
        )

        // Allow the devtools front-end re-point and hook re-installation to settle.
        // The elements-forward hook uses a polling interval after dom-ready; 1.8s
        // is the empirically validated window from the probe investigation.
        await new Promise((r) => setTimeout(r, 1800))

        // Core assertion: DOM.getDocument must route to the render guest, not the
        // service host. Retry with a 20s window to tolerate elements-forward drain
        // interval and new-guest priming.
        const root = await pollGetDocumentRoot(app, 20000, 4000)

        expect(
          root,
          `cycle ${cycle}: DOM.getDocument must return a root node within 20s after respawn — ` +
          'DevTools front-end or elements-forward hook may not be ready',
        ).toBeTruthy()

        const docUrl = String(root?.documentURL ?? root?.baseURL ?? '')

        expect(
          docUrl,
          `cycle ${cycle}: DOM.getDocument root.documentURL must point to the render guest ` +
          `(pageFrame.html) after respawn, but got: "${docUrl}". ` +
          'Elements has latched onto the service host or device shell.',
        ).toContain('pageFrame.html')

        expect(
          isServiceHostUrl(docUrl),
          `cycle ${cycle}: DOM.getDocument root.documentURL must NOT match any service-host ` +
          `or device-shell pattern, but got: "${docUrl}"`,
        ).toBe(false)
      } finally {
        // Restore the original source so the next cycle (or following spec) starts
        // clean. Use sync write to guarantee the file is on disk before settle.
        fs.writeFileSync(wxmlPath, original, 'utf8')
        await settleAfterRestore(win)
      }
    }
  })
})
