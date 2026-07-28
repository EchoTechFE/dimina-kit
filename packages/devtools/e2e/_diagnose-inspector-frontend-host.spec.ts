/**
 * DIAGNOSTIC (not a regression gate) — investigates whether
 * `InspectorFrontendHost.setPreference`/`.getPreferences`, as called by the
 * production Console-filter injection (console-filter.ts's
 * `buildConsoleFilterScript`, invoked from native-simulator-devtools-host.ts's
 * `applyConsoleFilter`), actually (a) exists and is callable on the right-panel
 * DevTools front-end host in this Electron version, (b) round-trips through
 * process memory, and (c) survives a CLEAN app shutdown to land in the on-disk
 * Preferences file. Real-machine observation was that `console.text-filter`
 * (and the unrelated `disable-locale-info-bar` write in devtools-tabs.ts) never
 * appear in `~/Library/Application Support/Dimina DevTools/Preferences` after
 * repeated runs — but those runs were killed with `kill -9`, which never lets
 * Electron flush prefs to disk, confounding the observation. This spec drives
 * the SAME injection paths under a Playwright-owned Electron process closed
 * with `electronApp.close()` (a real, clean shutdown) to separate "the
 * mechanism doesn't work" from "it was never allowed to flush".
 *
 * Everything here uses `webContents.executeJavaScript` via `evalInWebContentsByUrl`
 * (the exact mechanism `applyConsoleFilter`/`customizeDevtoolsTabs` use in
 * production) — never Playwright's own `page.evaluate()` CDP path, since that
 * talks to a DIFFERENT realm/binding surface than the production inject.
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
  evalInWebContentsByUrl,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { buildConsoleFilterScript } from '../src/main/services/views/console-filter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0
let userDataDir = ''

/** Execute JS in the DevTools front-end realm (devtools:// page), same helper native-host-devtools-*.spec.ts use. */
function evalInDevtools<T>(expr: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(electronApp, 'devtools://', expr).catch((e) => {
    // Surface the real error text instead of swallowing it into `null` — this
    // spec's whole point is to see actual failures, not summarize them away.
    return { __evalError: String((e as Error)?.message ?? e) } as unknown as T
  })
}

test.describe('DIAGNOSE: InspectorFrontendHost.setPreference/getPreferences real-machine behavior', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `diagnose-ifh-${process.pid}`,
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
    void autoPort

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    // Wait for a render-host guest so the service host (and therefore the
    // right-panel DevTools front-end pointed at it) is fully up.
    await pollUntil(
      () => electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html')),
      ),
      (present) => present === true,
      30000,
      300,
    )

    // Wait for the devtools:// front-end host wc to exist and be idle (loaded).
    await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const dt = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('devtools://'))
        return !!dt && !dt.isLoading()
      }),
      (ready) => ready === true,
      30000,
      300,
    )
  })

  test('FACT 1: what does globalThis.InspectorFrontendHost look like in the devtools:// front-end realm?', async () => {
    const surface = await evalInDevtools<Record<string, unknown>>(`(function(){
      var IFH = globalThis.InspectorFrontendHost;
      if (!IFH) return { exists: false };
      var out = { exists: true, typeofIFH: typeof IFH };
      out.ownKeys = Object.keys(IFH);
      try { out.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(IFH) || {}); } catch (e) { out.protoKeys = ['__err__' + String(e && e.message)]; }
      ['setPreference','getPreferences','removePreference'].forEach(function(m){ out['typeof_' + m] = typeof IFH[m]; });
      return out;
    })()`)
    console.log('[diagnose] InspectorFrontendHost surface:', JSON.stringify(surface))
    expect(surface, 'evalInDevtools must not itself fail (front-end realm must be reachable)').toBeTruthy()
  })

  test('FACT 2: setPreference + getPreferences round-trip inside the SAME process (memory-only proof)', async () => {
    const result = await evalInDevtools<Record<string, unknown>>(`(function(){
      return new Promise(function(resolve){
        var settled = false;
        var done = function(v){ if (!settled) { settled = true; resolve(v); } };
        var timer = setTimeout(function(){ done({ ok:false, reason:'timeout waiting for getPreferences callback' }); }, 5000);
        try {
          var IFH = globalThis.InspectorFrontendHost;
          if (!IFH) { clearTimeout(timer); return done({ ok:false, reason:'no InspectorFrontendHost' }); }
          if (typeof IFH.setPreference !== 'function' || typeof IFH.getPreferences !== 'function') {
            clearTimeout(timer);
            return done({ ok:false, reason:'setPreference/getPreferences missing', keys: Object.keys(IFH) });
          }
          IFH.setPreference('e2e-diagnose-probe', JSON.stringify('probe-value'));
          IFH.getPreferences(function(prefs){
            clearTimeout(timer);
            try {
              done({ ok:true, hasPrefsObj: !!prefs, readback: prefs ? prefs['e2e-diagnose-probe'] : undefined });
            } catch (e) { done({ ok:false, reason:'callback threw: ' + String(e && e.message) }); }
          });
        } catch (e) {
          clearTimeout(timer);
          done({ ok:false, reason:'setPreference/getPreferences call threw: ' + String(e && e.message) });
        }
      });
    })()`)
    console.log('[diagnose] setPreference/getPreferences round-trip:', JSON.stringify(result))
    expect(result, 'evalInDevtools must not itself fail').toBeTruthy()
  })

  test('FACT 3: invoke the REAL production buildConsoleFilterScript() and read back console.text-filter', async () => {
    // This mirrors exactly what applyConsoleFilter() does in production
    // (native-simulator-devtools-host.ts): inject the generated script via
    // executeJavaScript on the devtools:// front-end host. Note the production
    // code path already runs this automatically once the front-end points at
    // the service host (during openProjectInUI above), so this call is a
    // second, idempotent application — its self-healing "stale default" check
    // means a second run does not corrupt the first result.
    const script = buildConsoleFilterScript()
    await evalInDevtools(script)

    const readback = await evalInDevtools<Record<string, unknown>>(`(function(){
      return new Promise(function(resolve){
        var timer = setTimeout(function(){ resolve({ ok:false, reason:'timeout' }); }, 5000);
        try {
          var IFH = globalThis.InspectorFrontendHost;
          if (!IFH || typeof IFH.getPreferences !== 'function') { clearTimeout(timer); return resolve({ ok:false, reason:'no getPreferences' }); }
          IFH.getPreferences(function(prefs){
            clearTimeout(timer);
            resolve({
              ok:true,
              'console.text-filter': prefs ? prefs['console.text-filter'] : undefined,
              'console.text-filter.dimina-default': prefs ? prefs['console.text-filter.dimina-default'] : undefined,
            });
          });
        } catch (e) { clearTimeout(timer); resolve({ ok:false, reason: String(e && e.message) }); }
      });
    })()`)
    console.log('[diagnose] console.text-filter in-process readback after buildConsoleFilterScript():', JSON.stringify(readback))
    expect(readback, 'evalInDevtools must not itself fail').toBeTruthy()
  })

  test('FACT 4: clean electronApp.close() then read the on-disk Preferences file for BOTH probe keys', async () => {
    // Clean shutdown — NOT kill -9 — the exact variable this diagnosis isolates.
    await closeProject(mainWindow).catch(() => {})
    await electronApp.close()

    const prefsPath = path.join(userDataDir, 'Preferences')
    const exists = fs.existsSync(prefsPath)
    console.log('[diagnose] userDataDir:', userDataDir)
    console.log('[diagnose] Preferences file exists at', prefsPath, ':', exists)

    if (!exists) {
      // Report the actual directory listing so "file not found" isn't summarized
      // into a guess about where Electron put it.
      const listing = fs.existsSync(userDataDir) ? fs.readdirSync(userDataDir) : ['<userDataDir missing>']
      console.log('[diagnose] userDataDir listing:', JSON.stringify(listing))
      throw new Error(`Preferences file not found at ${prefsPath}; userDataDir listing: ${JSON.stringify(listing)}`)
    }

    const raw = fs.readFileSync(prefsPath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      console.log('[diagnose] Preferences file is not valid JSON; raw length', raw.length, 'first 500 chars:', raw.slice(0, 500))
      throw e
    }
    const devtoolsPrefs = (parsed as { electron?: { devtools?: { preferences?: Record<string, unknown> } } })
      ?.electron?.devtools?.preferences
    console.log('[diagnose] electron.devtools.preferences keys on disk:', devtoolsPrefs ? Object.keys(devtoolsPrefs) : '<electron.devtools.preferences missing entirely>')
    console.log('[diagnose] on-disk e2e-diagnose-probe:', JSON.stringify(devtoolsPrefs?.['e2e-diagnose-probe']))
    console.log('[diagnose] on-disk console.text-filter:', JSON.stringify(devtoolsPrefs?.['console.text-filter']))
    console.log('[diagnose] on-disk console.text-filter.dimina-default:', JSON.stringify(devtoolsPrefs?.['console.text-filter.dimina-default']))
    console.log('[diagnose] on-disk panel-selected-tab (known-good precedent from a live user click, per console-filter.ts comment):', JSON.stringify(devtoolsPrefs?.['panel-selected-tab']))
  })
})
