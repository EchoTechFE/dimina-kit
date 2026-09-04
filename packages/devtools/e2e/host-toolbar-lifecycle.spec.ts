import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * The host-slot port channel over a REAL app lifetime: first load, renderer
 * crash + rebuild, a project window closing + reopening, app quit.
 *
 * Every BrowserWindow owns its own `WorkbenchContext`/`ViewManager` (see
 * host-toolbar.spec.ts), so "the toolbar" is not one instance here — a
 * workbench window's toolbar is scoped to that window and is torn down with
 * it, while the project-list window's toolbar is genuinely host-scoped: it
 * is never touched by any project window's lifecycle. Each invariant below
 * is driven against the scope it actually applies to:
 *  - crash/rebuild and the no-growth cycle exercise a WORKBENCH window's
 *    toolbar, since that is the instance whose webContents is torn down and
 *    rebuilt by the operations under test;
 *  - "closing a project doesn't disturb the host slot" is now about the LIST
 *    window's toolbar — closing a project destroys the workbench window (and
 *    its own toolbar) wholesale, so there is nothing on that side left to
 *    assert non-disturbance about. What must not move is the list window's
 *    own toolbar webContents id and live port across a project window's full
 *    open → close → reopen cycle;
 *  - quitting tears down the whole process either way.
 *
 * Why a live app and not more fakes: the channel releases each webContents
 * through a per-wc attachment whose `dispose()` calls `webContents.off(...)`,
 * sometimes on a wc that is mid-death (the crash path). Unit tests drive that
 * against a fake emitter; only a real run shows Electron accepts those calls
 * and that teardown neither throws nor leaves the channel wired to a document
 * that is gone.
 *
 * What this spec does NOT prove, measured rather than assumed: deleting the
 * attachment release from the managed view keeps this spec fully green. On
 * every production path a released wc is destroyed moments later, so its own
 * `destroyed` handler closes the port anyway and a destroyed wc no longer
 * appears in the census. The release matters for a wc that is handed back
 * while still ALIVE — no current owner does that, which is why the per-wc
 * release is pinned by the unit tests instead.
 */

type Scope = 'workbench' | 'list'

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
  __e2eHostToolbarInstance: {
    context: { views: { hostToolbar: ToolbarSurface } }
    projectWindows(): Array<{ context: { views: { hostToolbar: ToolbarSurface } } }>
  }
  __e2eLifecyclePings?: Record<Scope, Array<{ from?: string; tag?: string }>>
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
    await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 20_000 })
  })

  test.afterAll(async () => {
    if (appClosed) return
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  // Every helper below re-resolves the toolbar surface for `scope` inline,
  // inside its own `electronApp.evaluate` callback: a function reference from
  // this module cannot cross into the main process, only serializable data
  // (the `scope` string) can.

  /** The slot's live webContents id for `scope`, or null when there is no live view. */
  const toolbarWcId = (scope: Scope) =>
    electronApp.evaluate((_mods, s) => {
      const g = globalThis as unknown as E2eGlobals
      const toolbar = s === 'workbench'
        ? g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar
        : g.__e2eHostToolbarInstance.context.views.hostToolbar
      const wc = toolbar?.webContents
      return wc && !wc.isDestroyed() ? wc.id : null
    }, scope)

  const inToolbarPage = (scope: Scope, code: string) =>
    electronApp.evaluate((_mods, args) => {
      const g = globalThis as unknown as E2eGlobals
      const toolbar = args.scope === 'workbench'
        ? g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar
        : g.__e2eHostToolbarInstance.context.views.hostToolbar
      const wc = toolbar?.webContents
      if (!wc || wc.isDestroyed()) return null
      return wc.executeJavaScript(args.code)
    }, { scope, code })

  const send = (scope: Scope, r: number) =>
    electronApp.evaluate((_mods, args) => {
      const g = globalThis as unknown as E2eGlobals
      const toolbar = args.scope === 'workbench'
        ? g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar
        : g.__e2eHostToolbarInstance.context.views.hostToolbar
      return toolbar ? toolbar.send('e2e:host', { round: args.round }) : false
    }, { scope, round: r })

  const pings = (scope: Scope) =>
    electronApp.evaluate((_mods, s) => {
      const g = globalThis as unknown as E2eGlobals
      return g.__e2eLifecyclePings?.[s] ?? []
    }, scope)

  const hostMsgs = async (scope: Scope): Promise<Array<{ round?: number }>> => {
    const v = await inToolbarPage(scope, 'Array.isArray(window.__hostMsgs) ? window.__hostMsgs : null')
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

  /**
   * Wire the ping listener for `scope` exactly once per toolbar instance. A
   * workbench window's toolbar is a fresh instance every time its window is
   * (re)opened, so this cannot be a one-shot beforeAll registration the way a
   * single persistent window allowed — it must re-register whenever `scope`
   * resolves to a toolbar it has not seen yet, and stay a no-op for one it has
   * (re-registering on an unchanged instance would double every ping).
   */
  async function ensurePingsRegistered(scope: Scope): Promise<void> {
    await electronApp.evaluate((_mods, s) => {
      const g = globalThis as unknown as E2eGlobals & { __e2eWiredToolbars?: WeakSet<object> }
      g.__e2eLifecyclePings ??= { workbench: [], list: [] }
      g.__e2eWiredToolbars ??= new WeakSet()
      const toolbar = s === 'workbench'
        ? g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar
        : g.__e2eHostToolbarInstance.context.views.hostToolbar
      if (toolbar && !g.__e2eWiredToolbars.has(toolbar)) {
        g.__e2eWiredToolbars.add(toolbar)
        toolbar.onMessage('e2e:ping', (payload) => {
          g.__e2eLifecyclePings![s].push(payload as { from?: string; tag?: string })
        })
      }
    }, scope)
  }

  /** Prove the current document delivers, exactly once, for a fresh round. */
  async function proveDelivery(scope: Scope): Promise<void> {
    const r = ++round
    await pollUntil(() => send(scope, r), (ok) => ok === true, 30_000, 300)
    const got = await pollUntil(
      () => hostMsgs(scope),
      (msgs) => msgs.some((m) => m?.round === r),
      15_000,
      300,
    )
    expect(
      got.filter((m) => m?.round === r),
      'one send() must arrive exactly once in the current document',
    ).toHaveLength(1)
  }

  /** Load the fixture into `scope`'s slot and prove the round trip on that document. */
  async function loadAndProveRoundTrip(scope: Scope): Promise<void> {
    await ensurePingsRegistered(scope)
    const before = (await pings(scope)).length
    await electronApp.evaluate((_mods, args) => {
      const g = globalThis as unknown as E2eGlobals
      const toolbar = args.scope === 'workbench'
        ? g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar
        : g.__e2eHostToolbarInstance.context.views.hostToolbar
      return toolbar?.loadFile(args.file)
    }, { scope, file: toolbarFixture })

    // page→host: the fixture sends at script-run time, before the handshake,
    // so this also exercises the preload's pending queue on every load.
    const seen = await pollUntil(() => pings(scope), (v) => v.length > before, 30_000, 300)
    expect(seen[seen.length - 1]?.from).toBe('page')

    await proveDelivery(scope)
  }

  test('a renderer crash tears the slot down; the rebuilt document owns the channel alone', async () => {
    await loadAndProveRoundTrip('workbench')
    const crashedId = await toolbarWcId('workbench')
    expect(crashedId).not.toBeNull()

    await electronApp.evaluate(() => {
      const g = globalThis as unknown as E2eGlobals
      g.__e2eHostToolbarInstance.projectWindows()[0]?.context.views.hostToolbar.webContents?.forcefullyCrashRenderer()
    })

    // The manager destroys the broken view, so the slot reports no live wc and
    // send() is gated again instead of claiming delivery into a dead document.
    await pollUntil(() => toolbarWcId('workbench'), (id) => id === null, 30_000, 300)
    expect(await send('workbench', ++round)).toBe(false)

    // The crashed wc is really gone — nothing can hand the channel back to it.
    const stillAlive = await electronApp.evaluate(
      ({ webContents }, id) =>
        webContents.getAllWebContents().some((wc) => wc.id === id && !wc.isDestroyed()),
      crashedId!,
    )
    expect(stillAlive).toBe(false)

    await loadAndProveRoundTrip('workbench')
    expect(await toolbarWcId('workbench'), 'the rebuild must be a different webContents').not.toBe(crashedId)
  })

  test('the list window\'s host-scoped toolbar and its live port survive a project window opening, closing, and reopening', async () => {
    await loadAndProveRoundTrip('list')
    const idBefore = await toolbarWcId('list')
    expect(idBefore).not.toBeNull()

    await closeProject(electronApp)

    // The workbench window this destroys owns its OWN toolbar and dies with
    // it; the list window and its toolbar are a separate window nothing in
    // the project lifecycle reaches.
    expect(await toolbarWcId('list'), 'the host-scoped toolbar must not move when a project window closes').toBe(idBefore)
    await proveDelivery('list')

    await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 20_000 })
    expect(await toolbarWcId('list')).toBe(idBefore)
    await proveDelivery('list')
  })

  test('an identical load → close → reopen cycle adds no webContents and no channel listener', async () => {
    async function cycle(): Promise<void> {
      await loadAndProveRoundTrip('workbench')
      await closeProject(electronApp)
      await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 20_000 })
      // The reopened window builds a brand-new toolbar view holding the
      // default document, so the round trip has to be re-established on it
      // rather than measured on a recorder that only ever existed in the
      // destroyed window's document.
      await loadAndProveRoundTrip('workbench')
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
