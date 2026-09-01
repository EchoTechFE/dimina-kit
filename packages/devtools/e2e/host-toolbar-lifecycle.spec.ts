import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil, findMainWindow } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * The host-slot port channel over a REAL app lifetime: first load, renderer
 * crash + rebuild, close project → reopen, app quit.
 *
 * Why a live app and not more fakes: the channel releases each webContents
 * through a per-wc attachment whose `dispose()` calls `webContents.off(...)`,
 * sometimes on a wc that is mid-death (the crash path). Unit tests drive that
 * against a fake emitter; only a real run shows Electron accepts those calls
 * and that teardown neither throws nor leaves the channel wired to a document
 * that is gone. Asserted here:
 *  - a rebuilt slot delivers to the NEW document exactly once, and send() is
 *    gated to false in the window where the slot has no live view;
 *  - project teardown leaves the host-scoped toolbar and its live port alone
 *    (`disposeProjectViews` exempts it on purpose);
 *  - repeating one identical cycle grows nothing on the main side: neither the
 *    number of live webContents nor the channel listeners resting on them. The
 *    absolute baseline is not this channel's alone, so growth across two equal
 *    cycles is the assertion, not the count itself;
 *  - quitting runs the whole teardown without a native crash and without an
 *    unexpected error line from this subsystem.
 *
 * What this spec does NOT prove, measured rather than assumed: deleting the
 * attachment release from the managed view keeps this spec fully green. On
 * every production path a released wc is destroyed moments later, so its own
 * `destroyed` handler closes the port anyway and a destroyed wc no longer
 * appears in the census. The release matters for a wc that is handed back
 * while still ALIVE — no current owner does that, which is why the per-wc
 * release is pinned by the unit tests instead.
 */

type ToolbarWebContents = {
  id: number
  isDestroyed(): boolean
  executeJavaScript(code: string): Promise<unknown>
  forcefullyCrashRenderer(): void
}
type ToolbarSurface = {
  loadFile(p: string): Promise<void>
  send(channel: string, payload: unknown): boolean
  onMessage(channel: string, handler: (payload: unknown) => void): { dispose(): void }
  webContents: ToolbarWebContents | null
}
type E2eGlobals = {
  __e2eHostToolbarInstance: { context: { views: { hostToolbar: ToolbarSurface } } }
  __e2eLifecyclePings?: Array<{ from?: string; tag?: string }>
}

/**
 * Error lines this spec causes on purpose: crashing the renderer makes the
 * manager report the teardown it is supposed to perform.
 */
const EXPECTED_ERROR_PATTERNS = [/render-process-gone/, /did-fail-load/]

test.describe('Host-slot port channel across the real app lifecycle', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  let electronApp: ElectronApplication
  let mainWindow: Page
  let appClosed = false
  const mainErrors: string[] = []
  /** Monotonic so every host→page envelope in this file is distinguishable. */
  let round = 0

  const toolbarFixture = path.join(FIXTURES, 'toolbar-port.html')

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-toolbar-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    electronApp.on('console', (msg) => {
      if (msg.type() === 'error') mainErrors.push(msg.text())
    })
    mainWindow = await findMainWindow(electronApp)
    await mainWindow.waitForLoadState('domcontentloaded')
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })

    // Registered ONCE: the handler lives in the channel's main-side registry,
    // which outlives every webContents here — only the slot's own dispose()
    // sweeps it. Re-registering per test would double every ping.
    await electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      g.__e2eLifecyclePings = []
      g.__e2eHostToolbarInstance.context.views.hostToolbar.onMessage('e2e:ping', (payload) => {
        g.__e2eLifecyclePings!.push(payload as { from?: string; tag?: string })
      })
    })
  })

  test.afterAll(async () => {
    if (appClosed) return
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  /** The slot's live webContents id, or null when there is no live view. */
  const toolbarWcId = () =>
    electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      const wc = g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents
      return wc && !wc.isDestroyed() ? wc.id : null
    })

  const inToolbarPage = (code: string) =>
    electronApp.evaluate(async (_mods, expr) => {
      const g = globalThis as unknown as E2eGlobals
      const wc = g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents
      if (!wc || wc.isDestroyed()) return null
      return wc.executeJavaScript(expr)
    }, code)

  const send = (r: number) =>
    electronApp.evaluate((_mods, n) => {
      const g = globalThis as unknown as E2eGlobals
      return g.__e2eHostToolbarInstance.context.views.hostToolbar.send('e2e:host', { round: n })
    }, r)

  const pings = () =>
    electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      return g.__e2eLifecyclePings ?? []
    })

  const hostMsgs = async (): Promise<Array<{ round?: number }>> => {
    const v = await inToolbarPage('Array.isArray(window.__hostMsgs) ? window.__hostMsgs : null')
    return Array.isArray(v) ? (v as Array<{ round?: number }>) : []
  }

  /**
   * Live webContents and the channel's listeners resting on them, counted from
   * the main process. Catches the leaks that survive a cycle: a view that was
   * never destroyed, or a second set of listeners stacked on a wc that is
   * reused across loads.
   */
  const census = () =>
    electronApp.evaluate(({ webContents }) => {
      const live = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
      let didFinishLoad = 0
      let didStartNavigation = 0
      for (const wc of live) {
        didFinishLoad += wc.listenerCount('did-finish-load')
        didStartNavigation += wc.listenerCount('did-start-navigation')
      }
      return { live: live.length, didFinishLoad, didStartNavigation }
    })

  /** Prove the current document delivers, exactly once, for a fresh round. */
  async function proveDelivery(): Promise<void> {
    const r = ++round
    await pollUntil(() => send(r), (ok) => ok === true, 30_000, 300)
    const got = await pollUntil(
      hostMsgs,
      (msgs) => msgs.some((m) => m?.round === r),
      15_000,
      300,
    )
    expect(
      got.filter((m) => m?.round === r),
      'one send() must arrive exactly once in the current document',
    ).toHaveLength(1)
  }

  /** Load the fixture into the slot and prove the round trip on that document. */
  async function loadAndProveRoundTrip(): Promise<void> {
    const before = (await pings()).length
    await electronApp.evaluate((_mods, file) => {
      const g = globalThis as unknown as E2eGlobals
      return g.__e2eHostToolbarInstance.context.views.hostToolbar.loadFile(file)
    }, toolbarFixture)

    // page→host: the fixture sends at script-run time, before the handshake,
    // so this also exercises the preload's pending queue on every load.
    const seen = await pollUntil(pings, (v) => v.length > before, 30_000, 300)
    expect(seen[seen.length - 1]?.from).toBe('page')

    await proveDelivery()
  }

  test('a renderer crash tears the slot down; the rebuilt document owns the channel alone', async () => {
    await loadAndProveRoundTrip()
    const crashedId = await toolbarWcId()
    expect(crashedId).not.toBeNull()

    await electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents?.forcefullyCrashRenderer()
    })

    // The manager destroys the broken view, so the slot reports no live wc and
    // send() is gated again instead of claiming delivery into a dead document.
    await pollUntil(toolbarWcId, (id) => id === null, 30_000, 300)
    expect(await send(++round)).toBe(false)

    // The crashed wc is really gone — nothing can hand the channel back to it.
    const stillAlive = await electronApp.evaluate(
      ({ webContents }, id) =>
        webContents.getAllWebContents().some((wc) => wc.id === id && !wc.isDestroyed()),
      crashedId!,
    )
    expect(stillAlive).toBe(false)

    await loadAndProveRoundTrip()
    expect(await toolbarWcId(), 'the rebuild must be a different webContents').not.toBe(crashedId)
  })

  test('closing the project leaves the host-scoped slot and its live port untouched', async () => {
    const idBefore = await toolbarWcId()
    expect(idBefore).not.toBeNull()

    await closeProject(mainWindow)

    // disposeProjectViews exempts the host toolbar: same webContents, same
    // document, same open port — no re-handshake needed.
    expect(await toolbarWcId(), 'project teardown must not destroy the host toolbar').toBe(idBefore)
    await proveDelivery()

    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
    expect(await toolbarWcId()).toBe(idBefore)
    await proveDelivery()
  })

  test('an identical load → close → reopen cycle adds no webContents and no channel listener', async () => {
    async function cycle(): Promise<void> {
      await loadAndProveRoundTrip()
      await closeProject(mainWindow)
      await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
      await proveDelivery()
    }

    await cycle()
    const first = await census()
    await cycle()
    const second = await census()

    const detail = `${JSON.stringify(first)} → ${JSON.stringify(second)}`
    expect(second.live, `live webContents grew across an identical cycle: ${detail}`)
      .toBeLessThanOrEqual(first.live)
    expect(second.didFinishLoad, `did-finish-load listeners grew across an identical cycle: ${detail}`)
      .toBeLessThanOrEqual(first.didFinishLoad)
    expect(second.didStartNavigation, `did-start-navigation listeners grew across an identical cycle: ${detail}`)
      .toBeLessThanOrEqual(first.didStartNavigation)
  })

  test('quitting runs the full teardown without a native crash or an unexpected error', async () => {
    const proc = electronApp.process()
    await electronApp.close()
    appClosed = true

    expect(
      proc.signalCode,
      `the app was killed by ${proc.signalCode} instead of exiting — teardown crashed natively`,
    ).toBeNull()

    // Scoped to this subsystem: unrelated app noise is not this spec's verdict,
    // but a throw out of the channel's release path would land here.
    const unexpected = mainErrors.filter(
      (line) =>
        /host-toolbar|host-slot|port/i.test(line)
        && !EXPECTED_ERROR_PATTERNS.some((re) => re.test(line)),
    )
    expect(unexpected, `unexpected host-slot error lines:\n${unexpected.join('\n')}`).toEqual([])
  })
})
