import type { Page, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProjectsChannel, SimulatorChannel } from '../src/shared/ipc-channels'
import { DMB_PAGEFRAME_DOC_NAME } from '../src/shared/dmb-resource-url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Paths ──────────────────────────────────────────────────────────────

const DEMO_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'demo-app'),
]

function resolveDemoAppSourceDir(): string {
  const found = DEMO_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'project.config.json')))
  if (!found) {
    throw new Error(`No demo app found. Checked: ${DEMO_CANDIDATES.join(', ')}`)
  }
  return found
}

/**
 * Per-worker demo-app copy. Workers used to share one mutable demo-app at the
 * repo path, and several specs mutate its sources (relaunch-resilience,
 * editor-hot-reload) — with hot reload actually working, a mutation made by
 * one worker triggers a watcher rebuild + DeviceShell respawn inside EVERY
 * concurrently-open session of the same project path, failing unrelated
 * assertions mid-flight in the other worker. (The interference existed
 * before, but was invisible while the renderer dropped the `hotReload` flag.)
 *
 * Keyed by TEST_PARALLEL_INDEX (stable across worker restarts, unlike
 * TEST_WORKER_INDEX) so a respawned worker reuses the same project path. The
 * copy is recreated fresh at worker startup so mutation residue from an
 * interrupted previous run can never leak into this one — and the repo's
 * demo-app stays pristine even when a spec's restore path is cut short.
 */
function resolveDemoAppDir(): string {
  const source = resolveDemoAppSourceDir()
  const parallelIndex = process.env.TEST_PARALLEL_INDEX
  if (parallelIndex === undefined) return source
  const copy = path.join(os.tmpdir(), 'dimina-kit-e2e', `demo-app-w${parallelIndex}`)
  fs.rmSync(copy, { recursive: true, force: true })
  fs.cpSync(source, copy, { recursive: true })
  return copy
}

/** Source demo mini-app for compilation tests. */
export const DEMO_APP_DIR = resolveDemoAppDir()

// ── URL markers ────────────────────────────────────────────────────────

/**
 * Substring that identifies a render-host guest's `webContents.getURL()`
 * (matched against, filtered on, or passed to `evalInWebContentsByUrl`
 * across specs). Re-exports the same reserved document name the render
 * host itself navigates to (`buildRenderHostDocumentUrl` in
 * `dmb-resource-url.ts`) so specs never hardcode the literal — a previous
 * fix moved the render-host document off the old fixed `pageFrame.html`
 * path and every spec that had inlined that string silently stopped
 * matching anything, turning negative assertions (`.filter(...).length`
 * should be 0) into no-ops instead of failures.
 */
export const RENDER_GUEST_URL_MARKER = DMB_PAGEFRAME_DOC_NAME

// ── Window resolution ──────────────────────────────────────────────────

/**
 * Matches the main renderer entry regardless of which `*-entry.js` booted
 * the app — `createConfiguredMainWindow` in app.ts always points the main
 * `BrowserWindow` at `entries/main/index.html`.
 */
const MAIN_WINDOW_URL_PATTERN = /entries\/main\//
const HOST_SIDEBAR_DEFAULT_URL_PATTERN = /entries\/host-sidebar-default\//

/**
 * Matches a workbench window — the window a project opens into. Each open
 * project gets its own, and the project-list window stays alive alongside
 * them, so "the app's window" is never a single thing: a spec must say which
 * one it means.
 */
const WORKBENCH_WINDOW_URL_PATTERN = /entries\/workbench\//

/**
 * Resolve a specific app window by matching its URL, instead of trusting
 * `electronApp.firstWindow()` / `electronApp.windows()[0]` (which does not
 * reliably correlate with BrowserWindow creation order — see
 * `findMainWindow`'s doc comment).
 */
async function findWindowBy(
  electronApp: ElectronApplication,
  accepts: (win: Page) => boolean,
  label: string,
  wanted: string,
  timeoutMs: number,
): Promise<Page> {
  const immediate = electronApp.windows().find(accepts)
  if (immediate) return immediate

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await electronApp
      .waitForEvent('window', { timeout: Math.max(0, deadline - Date.now()) })
      .catch(() => undefined)
    const match = electronApp.windows().find(accepts)
    if (match) return match
  }

  throw new Error(
    `${label}: no window matching ${wanted} within ${timeoutMs}ms `
    + `(open windows: ${electronApp.windows().map((win) => win.url()).join(', ') || 'none'})`,
  )
}

async function findWindowByUrlPattern(
  electronApp: ElectronApplication,
  pattern: RegExp,
  label: string,
  timeoutMs: number,
): Promise<Page> {
  return findWindowBy(electronApp, (win) => pattern.test(win.url()), label, String(pattern), timeoutMs)
}

/** The `path` a workbench window was booted with, or null for any other window. */
function workbenchProjectDir(win: Page): string | null {
  const url = win.url()
  if (!WORKBENCH_WINDOW_URL_PATTERN.test(url)) return null
  try {
    return new URL(url).searchParams.get('path')
  } catch {
    return null
  }
}

/**
 * Resolve the window a project is open in.
 *
 * Pass `projectDir` whenever the spec knows which project it means — several
 * workbench windows can be open at once, and matching on the entry URL alone
 * would hand back whichever one Playwright happens to list first. The window
 * carries its project in the `path` query `openProjectWindow` boots it with.
 */
export async function findWorkbenchWindow(
  electronApp: ElectronApplication,
  { projectDir, timeoutMs = 30_000 }: { projectDir?: string; timeoutMs?: number } = {},
): Promise<Page> {
  return findWindowBy(
    electronApp,
    (win) => {
      const dir = workbenchProjectDir(win)
      if (dir === null) return false
      return projectDir === undefined || dir === projectDir
    },
    'findWorkbenchWindow',
    projectDir === undefined ? String(WORKBENCH_WINDOW_URL_PATTERN) : `a workbench window for ${projectDir}`,
    timeoutMs,
  )
}

/** Every workbench window currently open, in Playwright's listing order. */
export function listWorkbenchWindows(electronApp: ElectronApplication): Page[] {
  return electronApp.windows().filter((win) => workbenchProjectDir(win) !== null)
}

/**
 * Resolve the app's actual main window instead of trusting
 * `electronApp.firstWindow()` / `electronApp.windows()[0]`.
 *
 * devtools auto-loads a host-sidebar default-content page
 * (`entries/host-sidebar-default/index.html`) into a second WebContentsView
 * very early during every boot, before any host `onSetup` callback runs.
 * That second page is small and finishes navigating fast enough that
 * Playwright's "first window" bookkeeping does not reliably correlate with
 * BrowserWindow creation order — it has been observed to hand back the
 * sidebar's page instead of the main app's page. Every window lookup in
 * this suite must therefore disambiguate by URL.
 */
export async function findMainWindow(electronApp: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  return findWindowByUrlPattern(electronApp, MAIN_WINDOW_URL_PATTERN, 'findMainWindow', timeoutMs)
}

/**
 * Drive devtools' own project-list category rail (the host-sidebar default
 * content) exactly as a user would: locate its WebContentsView page and
 * activate the icon button for `category`. Real projects are filtered by
 * `Project.type` against the selected category (default 'miniprogram'), so
 * opening a mini-game project through the UI requires this switch first.
 *
 * Dispatches a native DOM `click()` inside the sidebar page rather than
 * Playwright's mouse-coordinate-driven `locator(...).click()`: this WCV is a
 * secondary, layered contentView (not its own top-level BrowserWindow), and
 * its real on-screen bounds only settle once the forward view-anchor loop
 * (advertise → main → placeholder resize → anchor reposition) has converged
 * — before that Playwright's actionability check reports the element as
 * "outside the viewport" even though it is already laid out in the DOM. A
 * programmatic click fires the same React `onClick` handler without
 * depending on that geometry.
 */
export async function selectProjectCategoryInUI(
  electronApp: ElectronApplication,
  category: 'miniprogram' | 'minigame',
): Promise<void> {
  const sidebar = await findWindowByUrlPattern(
    electronApp,
    HOST_SIDEBAR_DEFAULT_URL_PATTERN,
    'selectProjectCategoryInUI',
    30_000,
  )
  const label = category === 'miniprogram' ? '小程序' : '小游戏'
  await sidebar.waitForSelector(`[aria-label="${label}"]`)
  await sidebar.evaluate((selector) => {
    document.querySelector<HTMLButtonElement>(selector)?.click()
  }, `[aria-label="${label}"]`)
}

// ── IPC helpers ────────────────────────────────────────────────────────

/**
 * Invoke an IPC handler from the renderer process.
 * Uses the contextBridge-exposed `window.devtools.ipc` surface.
 */
export async function ipcInvoke<T = unknown>(
  mainWindow: Page,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return mainWindow.evaluate(
    async ({ channel, args }) => {
      const ipc = (window as unknown as { devtools?: { ipc?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } } }).devtools?.ipc
      if (!ipc?.invoke) throw new Error('[e2e] window.devtools.ipc unavailable — preload bridge missing?')
      return ipc.invoke(channel, ...args)
    },
    { channel, args }
  ) as Promise<T>
}

// ── Project lifecycle ──────────────────────────────────────────────────

/**
 * Add a project via IPC (does not navigate to project view).
 *
 * Skips the call when the workspace already lists the project: production
 * `ProjectsChannel.Add` pops a blocking `dialog.showMessageBox` on duplicates,
 * which would hang the test main process for the full hook timeout because
 * nobody clicks the OK button in headless mode.
 */
export async function addProject(mainWindow: Page, projectDir: string): Promise<void> {
  const existing = await ipcInvoke<Array<{ path: string }> | undefined>(mainWindow, ProjectsChannel.List)
  if (existing?.some((p) => p.path === projectDir)) return
  await ipcInvoke(mainWindow, ProjectsChannel.Add, projectDir)
}

/**
 * `Main`'s `projectList` state only refetches on mount and on the
 * `window:navigateBack` event (see `main.tsx`) — a project added via raw IPC
 * (`addProject`) does not push a live update, so the list screen won't show
 * it until this fires.
 */
export async function refreshProjectList(mainWindow: Page): Promise<void> {
  await mainWindow.evaluate(() => {
    const testIpc = (window as unknown as { __testIpc?: { emit: (c: string) => void } }).__testIpc
    testIpc?.emit('window:navigateBack')
  })
}

/**
 * Close an open project by closing the window it lives in — the user-driven
 * path, and the one that proves the window teardown really disposes the
 * session. Safe to call when no project is open.
 *
 * Without `projectDir` this closes every open workbench window, which is what
 * a spec-level cleanup wants: whatever this file opened, leave nothing behind
 * for the next spec sharing the worker's Electron process.
 */
export async function closeProject(
  electronApp: ElectronApplication,
  { projectDir }: { projectDir?: string } = {},
): Promise<void> {
  const targets = listWorkbenchWindows(electronApp)
    .filter((win) => projectDir === undefined || workbenchProjectDir(win) === projectDir)
  for (const win of targets) {
    // The renderer detaches on its own as the window tears down; asking for it
    // first keeps the simulator WCV from being torn off mid-frame. A window
    // with no simulator attached rejects this, which is not a close failure.
    await ipcInvoke(win, SimulatorChannel.Detach).catch(() => {})
    // `BrowserWindow.close()`, not Playwright's `page.close()`: the app hangs
    // every project teardown (session, editor server, IPC registrations, the
    // floating DevTools window) off the window's `close` event, and
    // `page.close()` closes the CDP target — Chromium destroys the window
    // outright, emitting no `close`, so nothing is ever disposed. The window
    // then vanishes from the page list exactly as if it had been closed
    // properly, which makes the difference invisible from the test side.
    await electronApp.evaluate(({ BrowserWindow }, url) => {
      // A window that is already gone is fine and closes nothing; a main
      // process that cannot be reached at all is a failure and propagates.
      const target = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL() === url)
      target?.close()
    }, win.url())
  }
  const stuck = await pollUntil(
    async () => listWorkbenchWindows(electronApp).filter((win) => targets.includes(win)),
    (remaining) => remaining.length === 0,
    // Teardown now runs for real before the window goes away (compile session,
    // editor http server, views), so this waits on work, not on a destroy.
    30_000,
    100,
  )
  // `pollUntil` resolves with the last value instead of throwing on timeout,
  // so the count has to be asserted here. A window still listed means teardown
  // hung or the close was refused — the exact regression the close/reopen
  // specs exist to catch, and silently tolerating it lets them pass against a
  // project that never closed.
  if (stuck.length > 0) {
    const names = stuck.map((win) => workbenchProjectDir(win) ?? win.url()).join(', ')
    throw new Error(`closeProject: ${stuck.length} workbench window(s) still open after 30s: ${names}`)
  }
}

/**
 * Add a project and click its card, then resolve the workbench window it
 * opened into.
 *
 * Takes the app rather than a page because a project no longer opens *inside*
 * the window that was clicked: the project list stays where it is and the
 * project gets a window of its own. The returned page is that window — every
 * assertion about the simulator, the panels, the editor or the toolbar belongs
 * to it, not to the list window.
 *
 * Waits for the simulator webview to attach AND first-page DOM to be ready
 * (compile complete signal) instead of a fixed timer.
 *
 * @param waitMs - hard cap on total wait time (default 15000).
 */
export async function openProjectInUI(
  electronApp: ElectronApplication,
  projectDir: string,
  { waitMs = 15000 }: { waitMs?: number } = {}
): Promise<Page> {
  const listWindow = await findMainWindow(electronApp)
  await addProject(listWindow, projectDir)
  await refreshProjectList(listWindow)
  const projectPathLabel = listWindow.locator(`[title="${projectDir}"]`).first()
  await projectPathLabel.waitFor()
  await projectPathLabel.locator('..').click()

  const deadline = Date.now() + waitMs

  const workbench = await findWorkbenchWindow(electronApp, {
    projectDir,
    timeoutMs: Math.max(1000, deadline - Date.now()),
  })
  await workbench.waitForLoadState('domcontentloaded')
  await workbench.waitForSelector('text=普通编译')

  // 1) Wait for the simulator webview to attach.
  await workbench.waitForSelector('webview', { timeout: Math.max(1000, deadline - Date.now()) })
    .catch(() => {})

  // 2) Wait for the renderer to report compile complete or the toolbar to leave the
  //    "正在刷新..." / "正在编译..." state. The status text lives in a `.truncate` span
  //    bound to setCompileStatus messages: '编译完成', '编译完成，已热更新', '刷新完成'.
  await pollUntil(
    () => workbench.evaluate(() => {
      const els = document.querySelectorAll('[class*="truncate"]')
      for (const el of els) {
        const t = el.textContent || ''
        if (t.includes('完成')) return true
      }
      return false
    }),
    (done) => done === true,
    Math.max(1000, deadline - Date.now()),
    300,
  ).catch(() => {})

  return workbench
}

// ── Simulator helpers ──────────────────────────────────────────────────

/**
 * Execute JavaScript inside the simulator's webContents via the main process.
 * Retries up to 3 times if it is not yet available.
 *
 * The simulator's document loads `simulator.html` regardless of arch, so we
 * match on that URL — works for BOTH the default renderer `<webview>` AND the
 * native-host top-level WebContentsView (whose `getType()` is `'window'`, not
 * `'webview'`). The nested render-host page frames load `__frame__.html`, so
 * they're never mistaken for the simulator. Falls back to the legacy
 * `getType()==='webview'` match if no `simulator.html` content is found.
 */
export async function evalInSimulator<T = unknown>(
  electronApp: ElectronApplication,
  expression: string
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await electronApp.evaluate(async ({ webContents }, expr) => {
        const all = webContents.getAllWebContents()
        const sim = all.find((wc) => wc.getURL().includes('simulator.html'))
          ?? all.find((wc) => wc.getType() === 'webview')
        if (!sim) throw new Error('No webview found')
        // Don't queue a did-stop-loading waiter per retry on a loading wc —
        // fail this attempt and let the retry/pollUntil caller re-enter.
        if (sim.isLoading()) throw new Error('simulator wc is loading')
        return sim.executeJavaScript(expr)
      }, expression) as Promise<T>
    } catch (err) {
      lastErr = err
      const message = String(err)
      if (
        message.includes('No webview found')
        || message.includes('Script failed to execute')
      ) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export async function evalInWebContentsByUrl<T = unknown>(
  electronApp: ElectronApplication,
  urlSubstring: string,
  expression: string
): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const all = webContents.getAllWebContents()
    const target = all.find((wc) => wc.getURL().includes(payload.urlSubstring))
    if (!target) throw new Error(`No webContents found for ${payload.urlSubstring}`)
    // A did-stop-loading waiter would queue per call on a loading wc; fail fast.
    if (target.isLoading()) throw new Error(`webContents for ${payload.urlSubstring} is loading`)
    return target.executeJavaScript(payload.expression)
  }, { urlSubstring, expression }) as Promise<T>
}

export interface ConsoleErrorEntry {
  level: 'error' | 'warning'
  message: string
  url: string
  source: string
}

/**
 * Collect `error`/`warning` console messages from EVERY webContents (existing
 * and future) into a main-process global. Install this right after
 * `_electron.launch`, BEFORE opening a project, so it captures preload-load
 * failures and early frame errors (the simulator WCV, render-host guests and
 * service-host window are created on project open).
 *
 * Why a real test for this: console-level failures (a preload that fails to
 * load, a bridge that throws) don't break DOM-existence / data-flow assertions,
 * so the rest of the suite stays green while the simulator quietly logs errors.
 * `assertNoConsoleErrors` turns that invisible breakage into a hard failure.
 */
export async function installConsoleCollector(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app, webContents }) => {
    const g = globalThis as unknown as { __e2eConsoleErrors?: unknown[] }
    if (g.__e2eConsoleErrors) return
    const errors: Array<{ level: string; message: string; url: string; source: string }> = []
    g.__e2eConsoleErrors = errors
    const levelName = (lvl: unknown): string =>
      typeof lvl === 'string' ? lvl : (['verbose', 'info', 'warning', 'error'][Number(lvl)] ?? String(lvl))
    const attach = (wc: Electron.WebContents): void => {
      wc.on('console-message', (...args: unknown[]) => {
        // Electron 41 may pass either (event, details) or the legacy
        // (event, level, message, line, sourceId). Handle both shapes.
        let level: string
        let message: string
        let source: string
        const a1 = args[1]
        if (a1 && typeof a1 === 'object' && 'level' in (a1 as object)) {
          const d = a1 as { level: unknown; message?: unknown; sourceId?: unknown }
          level = levelName(d.level)
          message = String(d.message ?? '')
          source = String(d.sourceId ?? '')
        } else {
          level = levelName(args[1])
          message = String(args[2] ?? '')
          source = String(args[4] ?? '')
        }
        if (level === 'error' || level === 'warning') {
          let url = ''
          try { url = wc.getURL() } catch { /* destroyed */ }
          errors.push({ level, message: message.slice(0, 400), url: url.slice(0, 140), source: String(source).slice(0, 140) })
        }
      })
    }
    webContents.getAllWebContents().forEach(attach)
    app.on('web-contents-created', (_e, wc) => attach(wc))
  })
}

/** Read the collected console error/warning entries. */
export async function readConsoleErrors(electronApp: ElectronApplication): Promise<ConsoleErrorEntry[]> {
  return electronApp.evaluate(() => {
    const g = globalThis as unknown as { __e2eConsoleErrors?: ConsoleErrorEntry[] }
    return (g.__e2eConsoleErrors ?? []).slice()
  }) as Promise<ConsoleErrorEntry[]>
}

/**
 * Wait until the editor dock body is mounted in the main window.
 *
 * The editor is the embedded A2 workbench, a main-process WebContentsView
 * overlaid onto the `[data-area="editor"]` anchor div (the workbench's own DOM
 * lives in a separate WebContents the main window cannot query). Readiness is
 * the anchor div appearing — the dock renders it as soon as the editor structural
 * body mounts; the WCV lazily attaches on the first non-zero bounds publish.
 */
export async function waitForEditorReady(
  mainWindow: Page,
  timeout = 25000,
): Promise<void> {
  await mainWindow.waitForSelector('[data-area="editor"]', { timeout })
}

export async function waitForSimulatorWebview(
  electronApp: ElectronApplication,
  timeout = 20000
): Promise<void> {
  await pollUntil(
    () => electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents()
      // Match the simulator document by URL (covers the default `<webview>` and
      // the native-host WebContentsView alike); fall back to the legacy
      // `'webview'` type check for safety.
      return all.some((wc) => wc.getURL().includes('simulator.html'))
        || all.some((wc) => wc.getType() === 'webview')
    }).catch(() => false),
    (present) => present === true,
    timeout,
    500
  )
}

/**
 * Wait until the simulator <webview> can execute JS — i.e. it has fired
 * `did-finish-load`. This is the signal the main-process CDP attacher uses
 * (see simulator-storage/index.ts onFinishLoad), so once this resolves the
 * `attachedWc` in simulator-storage is wired up and writes via the Storage
 * panel UI will land instead of silently failing under multi-worker e2e load.
 *
 * Implemented as a one-shot per poll (no nested retries) so timing is
 * predictable and the failure mode is "timed out" rather than compounding
 * 2s × 3 inner retries × N outer polls.
 */
export async function waitSimulatorReady(
  electronApp: ElectronApplication,
  timeout = 15000
): Promise<void> {
  await pollUntil(
    async () => {
      try {
        const out = await electronApp.evaluate(async ({ webContents }) => {
          const all = webContents.getAllWebContents()
          const sim = all.find((wc) => wc.getURL().includes('simulator.html'))
            ?? all.find((wc) => wc.getType() === 'webview')
          if (!sim) return null
          // A loading wc can't execute JS yet; probing it anyway queues one
          // did-stop-loading waiter PER POLL on the emitter (Electron defers
          // the eval), piling toward MaxListenersExceededWarning during long
          // relaunch windows. Report not-ready without queuing.
          if (sim.isLoading()) return null
          return sim.executeJavaScript('1')
        })
        return out === 1
      } catch {
        return false
      }
    },
    (ok) => ok === true,
    timeout,
    250,
  )
}

// ── Polling / async helpers ────────────────────────────────────────────

/**
 * Poll `fn` until `predicate` returns true, up to `timeout` ms.
 * On timeout, makes one final attempt that is allowed to throw.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeout = 15000,
  interval = 500
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const val = await fn()
      if (predicate(val)) return val
    } catch {
      // ignore intermediate errors
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return fn() // final attempt — let it throw
}

// ── UI query helpers ───────────────────────────────────────────────────

/**
 * Find a button by its text content.
 */
export async function findButtonByText(
  mainWindow: Page,
  text: string
): Promise<boolean> {
  return mainWindow.evaluate((t) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.textContent?.includes(t)) return true
    }
    return false
  }, text)
}

// ── Reset helpers (for shared-project pattern) ─────────────────────────

/**
 * Best-effort reset of in-simulator state between tests when reusing one
 * open project. Clears wx storage and unwinds the page stack to home.
 */
export async function resetSimulatorState(
  electronApp: ElectronApplication,
): Promise<void> {
  try {
    const isNativeHost = await evalInSimulator<boolean>(
      electronApp,
      `(() => !!document.querySelector('.device-shell-root'))()`,
    ).catch(() => false)

    if (isNativeHost) {
      await evalInSimulator(electronApp, `try { wx.clearStorageSync() } catch (e) {}`).catch(() => {})

      for (let attempt = 0; attempt < 5; attempt++) {
        const clickedBack = await evalInSimulator<boolean>(
          electronApp,
          `(() => {
            try {
              const webviews = document.querySelectorAll('.device-shell__webview')
              if (webviews.length <= 1) return false
              const backBtn = document.querySelector('.nav-bar__back')
              if (!backBtn || typeof backBtn.click !== 'function') return false
              backBtn.click()
              return true
            } catch (e) { return false }
          })()`,
        ).catch(() => false)
        if (!clickedBack) break
        await new Promise((r) => setTimeout(r, 350))
      }
      return
    }

    await evalInSimulator(electronApp, `try { wx.clearStorageSync() } catch (e) {}`).catch(() => {})

    // dimina's own page stack is unwound by clicking each
    // webview's back button (which calls miniApp.navigateBack internally). Loop
    // until only one webview remains (= home), or we hit a small safety bound.
    // We swallow errors so a flaky reset never blocks the next test.
    for (let attempt = 0; attempt < 8; attempt++) {
      const stillNonHome = await evalInSimulator<boolean>(
        electronApp,
        `(() => {
          try {
            const webviews = document.querySelectorAll('.dimina-native-view')
            if (webviews.length <= 1) return false
            const top = webviews[webviews.length - 1]
            const backBtn = top.querySelector('.dimina-native-webview__navigation-left-btn')
            if (backBtn) (backBtn).click()
            return true
          } catch (e) { return false }
        })()`,
      ).catch(() => false)
      if (!stillNonHome) break
      // Small wait for dimina's exit animation; navigateBack guards on
      // webviewAnimaEnd so back-to-back clicks otherwise no-op.
      await new Promise((r) => setTimeout(r, 350))
    }
  } catch {
    // Best-effort reset must never block the next test.
  }
}
