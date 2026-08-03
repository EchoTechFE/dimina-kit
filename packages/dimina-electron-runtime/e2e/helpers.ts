import type { Page, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { DMB_PAGEFRAME_DOC_NAME } from '@dimina-kit/electron-runtime/shared/dmb-resource-url'

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
 * Per-worker demo-app copy — mirrors packages/devtools/e2e/helpers.ts: several
 * specs mutate the demo-app's sources (hot reload), and with hot reload
 * actually working a mutation from one worker would trigger a rebuild in
 * EVERY concurrently-open session of the same project path.
 */
function resolveDemoAppDir(): string {
  const source = resolveDemoAppSourceDir()
  const parallelIndex = process.env.TEST_PARALLEL_INDEX
  if (parallelIndex === undefined) return source
  const copy = path.join(os.tmpdir(), 'dimina-kit-e2e', `runtime-demo-app-w${parallelIndex}`)
  fs.rmSync(copy, { recursive: true, force: true })
  fs.cpSync(source, copy, { recursive: true })
  return copy
}

function readDemoProjectName(projectDir: string): string {
  try {
    const configPath = path.join(projectDir, 'project.config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectname?: string; appid?: string }
    return config.projectname || config.appid || path.basename(projectDir)
  } catch {
    return path.basename(projectDir)
  }
}

/** Source demo mini-app for compilation tests. */
export const DEMO_APP_DIR = resolveDemoAppDir()
export const DEMO_APP_NAME = readDemoProjectName(DEMO_APP_DIR)

// ── URL markers ────────────────────────────────────────────────────────

/**
 * Substring that identifies a render-host guest's `webContents.getURL()`.
 * Re-exports the runtime's own reserved document name so specs never
 * hardcode the literal.
 */
export const RENDER_GUEST_URL_MARKER = DMB_PAGEFRAME_DOC_NAME

// ── IPC helpers (test-preload.cjs's window.__diminaTestIpc passthrough) ──

export async function ipcInvoke<T = unknown>(
  mainWindow: Page,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return mainWindow.evaluate(
    async ({ channel, args }) => {
      const ipc = (window as unknown as { __diminaTestIpc?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }).__diminaTestIpc
      if (!ipc?.invoke) throw new Error('[e2e] window.__diminaTestIpc unavailable — test-preload.cjs missing?')
      return ipc.invoke(channel, ...args)
    },
    { channel, args }
  ) as Promise<T>
}

export async function ipcSend(
  mainWindow: Page,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  await mainWindow.evaluate(
    ({ channel, args }) => {
      const ipc = (window as unknown as { __diminaTestIpc?: { send?: (c: string, ...a: unknown[]) => void } }).__diminaTestIpc
      if (!ipc?.send) throw new Error('[e2e] window.__diminaTestIpc.send unavailable')
      ipc.send(channel, ...args)
    },
    { channel, args }
  )
}

// ── Project lifecycle (globalThis.__diminaE2eHooks, see electron-entry.js) ──

export interface OpenProjectResult {
  appId: string
  port: number
}

/** Open a project via the runtime's public `openProject` facade. */
export async function openProject(
  electronApp: ElectronApplication,
  projectDir: string,
  opts: Record<string, unknown> = {},
): Promise<OpenProjectResult> {
  return electronApp.evaluate(
    async (_electron, { projectDir, opts }) => {
      const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
        openProject: (dir: string, o?: Record<string, unknown>) => Promise<OpenProjectResult>
      }
      return hooks.openProject(projectDir, opts)
    },
    { projectDir, opts },
  ) as Promise<OpenProjectResult>
}

/** Close the current project session. Safe to call when no project is open. */
export async function closeProject(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(async () => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
      closeProject: () => Promise<void>
    }
    await hooks.closeProject()
  })
}

// ── Native-host introspection/automation (globalThis.__diminaE2eHooks) ───
// Direct in-process replacement for devtools' WS automation server
// (App.getPageStack / App.getCurrentPage / App.callWxMethod / Page.getData):
// Playwright drives THIS SAME process via electronApp.evaluate(), so there's
// no external client needing a WS/JSON-RPC layer to reach in.

export interface PageStackEntry {
  pageId: number
  path: string
  query: Record<string, string>
}

export interface CurrentPageInfo {
  pageId: number
  path: string
  query: Record<string, string>
}

export async function getPageStack(
  electronApp: ElectronApplication,
  appId?: string,
): Promise<PageStackEntry[]> {
  return electronApp.evaluate((_electron, appId) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
      getPageStack: (appId?: string) => PageStackEntry[]
    }
    return hooks.getPageStack(appId)
  }, appId)
}

export async function getCurrentPage(
  electronApp: ElectronApplication,
  appId?: string,
): Promise<CurrentPageInfo> {
  return electronApp.evaluate((_electron, appId) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
      getCurrentPage: (appId?: string) => Promise<CurrentPageInfo>
    }
    return hooks.getCurrentPage(appId)
  }, appId)
}

/**
 * Under sustained load (a long sequential run launching many dedicated
 * Electron processes back to back — see the full-suite run, not any single
 * spec in isolation) the main-process CDP evaluate channel can occasionally
 * fail a single round-trip with a generic "Script failed to execute" error
 * that carries no further detail.
 *
 * This does NOT retry: `method` here can be a NAV method (navigateTo/
 * redirectTo/reLaunch/switchTab/navigateBack), and a retry from this side of
 * the CDP boundary can't tell whether `wx.<method>(...)` already dispatched
 * before the failure — re-issuing it could push/switch a page a second time.
 * Neither does `runNativeHostNav` in electron-entry.js on the other side of
 * this call: two attempts at a safe retry there (a Playwright-side path
 * comparison, then a pre-dispatch bridge-id comparison) were both shown
 * unsound on review — an in-band signal can't establish per-invocation
 * causality here. A genuinely safe retry needs a correlation token threaded
 * through the actual nav protocol; don't reintroduce a signal-comparison
 * retry as a substitute (see electron-entry.js's comment on the same issue).
 */
export async function callWxMethod(
  electronApp: ElectronApplication,
  method: string,
  args: unknown[] = [],
  appId?: string,
): Promise<{ result: unknown }> {
  return electronApp.evaluate((_electron, payload) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
      callWxMethod: (method: string, args?: unknown[], appId?: string) => Promise<{ result: unknown }>
    }
    return hooks.callWxMethod(payload.method, payload.args, payload.appId)
  }, { method, args, appId })
}

export async function getPageData(
  electronApp: ElectronApplication,
  appId: string,
  path?: string,
): Promise<unknown> {
  return electronApp.evaluate((_electron, payload) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
      getPageData: (appId: string, path?: string) => unknown
    }
    return hooks.getPageData(payload.appId, payload.path)
  }, { appId, path })
}

// ── Simulator helpers (ported verbatim from packages/devtools/e2e/helpers.ts —
// these only ever touched webContents.getAllWebContents()/executeJavaScript,
// never devtools' own UI) ────────────────────────────────────────────────

/**
 * Execute JavaScript inside the simulator's webContents via the main process.
 * Retries up to 3 times if it is not yet available.
 *
 * Only retries on the two PRE-DISPATCH conditions below ("No webview found" /
 * "simulator wc is loading") — both are thrown before `expr` ever runs, so a
 * retry can't double-execute it. Deliberately does NOT retry on a generic
 * "Script failed to execute" (Playwright's wrapper for when `expr` itself
 * threw) — `expr` can be a non-idempotent operation at some call sites (e.g.
 * clicking a nav button, invoking a custom API), and that error is ambiguous
 * about whether `expr` already ran (a prior version of `callWxMethod` in this
 * same file retried on exactly this ambiguous case and could double-fire a
 * real `wx.navigateTo`; don't reintroduce that bug here).
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
        if (sim.isLoading()) throw new Error('simulator wc is loading')
        return sim.executeJavaScript(expr)
      }, expression) as Promise<T>
    } catch (err) {
      lastErr = err
      const message = String(err)
      if (
        message.includes('No webview found')
        || message.includes('simulator wc is loading')
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
 * and future) into a main-process global. Install right after `_electron.launch`.
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

export async function waitForSimulatorWebview(
  electronApp: ElectronApplication,
  timeout = 20000
): Promise<void> {
  await pollUntil(
    () => electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents()
      return all.some((wc) => wc.getURL().includes('simulator.html'))
        || all.some((wc) => wc.getType() === 'webview')
    }),
    (present) => present === true,
    timeout,
    500
  )
}

/**
 * Wait until the simulator <webview> can execute JS — i.e. it has fired
 * `did-finish-load`.
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
      await new Promise((r) => setTimeout(r, 350))
    }
  } catch {
    // Best-effort reset must never block the next test.
  }
}
