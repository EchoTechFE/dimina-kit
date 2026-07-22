/**
 * Behavior tests for `createGlobalDiagnosticsMirror`.
 *
 * The right-panel embedded Chrome DevTools is attached to a project's
 * service-host webContents and is meant for the user debugging THEIR
 * miniapp — `audience:'internal'` diagnostics (devtools-toolchain telemetry
 * like the compile-worker warm-standby lifecycle) are skipped there (see
 * `console-forward/index.ts`'s `handleDiagnostic`). Skipping them there must
 * not make them vanish: this mirror re-routes EVERY diagnostic — both
 * `'user'` and `'internal'`, unfiltered by audience — into the standalone
 * global DevTools window, so nothing reported on the bus is ever silently
 * lost.
 *
 * The mirror's subscription to the `DiagnosticsBus` is gated by whether the
 * standalone window is currently open (`onHostChanged`), exactly like
 * `createGlobalConsoleMirror`. This is the fix for the actual reported bug:
 * `DiagnosticsBus.subscribe` already supports `{replay:true}`, but the old
 * design subscribed ONCE at app-boot wiring time — long before the
 * standalone window could possibly exist — so the replay it received had no
 * live target to inject into and those diagnostics were silently dropped.
 * Gating the subscription on "window is currently open" means every open (or
 * reopen) starts a FRESH `{replay:true}` subscription against the bus's
 * CURRENT buffer, so historical diagnostics (e.g. the earliest
 * compile-standby events reported at boot, before anyone ever opened the
 * window) are always delivered the moment the window appears.
 *
 * No electron needed — a fake `DiagnosticsBus` (report/subscribe with
 * replay, mirroring `createDiagnosticsBus`'s real contract) plus a fake
 * WebContents exposing `isDestroyed`/`getURL`/`isLoadingMainFrame`/
 * `executeJavaScript` (same shape used elsewhere in this directory) is
 * enough.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Diagnostic, DiagnosticsBus } from '../diagnostics/index.js'
import { createGlobalDiagnosticsMirror } from './global-diagnostics-mirror.js'

/**
 * `deliver()` (in `open-gated-relay.ts`) now always routes `inject()` through
 * `Promise.resolve().then(...)` — even a synchronously-successful injection —
 * so it can react to the confirmed success/failure outcome (see that
 * module's doc for why: marking "injected" before the outcome is known used
 * to permanently black-hole a failed attempt). Tests that assert on `exec`
 * having been called must flush that microtask first.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeWc(opts: { destroyed?: boolean, loading?: boolean, url?: string } = {}): { wc: WebContents, exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => opts.destroyed ?? false,
    getURL: () => opts.url ?? 'file:///main-window.html',
    isLoadingMainFrame: () => opts.loading ?? false,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec }
}

/** Mirrors `createDiagnosticsBus`'s real report/subscribe/replay contract
 *  (see `../diagnostics/index.ts`) closely enough to exercise this mirror
 *  without depending on that module's own tests or implementation. */
function makeFakeDiagnosticsBus(): {
  bus: Pick<DiagnosticsBus, 'subscribe'>
  report: (d: Omit<Diagnostic, 'ts'>) => void
  subscribeSpy: ReturnType<typeof vi.fn>
  disposeSpies: ReturnType<typeof vi.fn>[]
} {
  const buffer: Diagnostic[] = []
  const sinks = new Set<(d: Diagnostic) => void>()
  const disposeSpies: ReturnType<typeof vi.fn>[] = []
  const subscribeSpy = vi.fn((sink: (d: Diagnostic) => void, opts?: { replay?: boolean }) => {
    const replay = opts?.replay ?? true
    if (replay) {
      for (const entry of buffer) sink(entry)
    }
    sinks.add(sink)
    let released = false
    const disposeSpy = vi.fn(() => {
      if (released) return
      released = true
      sinks.delete(sink)
    })
    disposeSpies.push(disposeSpy)
    return { dispose: disposeSpy }
  })
  return {
    bus: { subscribe: subscribeSpy },
    report: (d) => {
      const entry: Diagnostic = { ...d, ts: Date.now() }
      buffer.push(entry)
      for (const sink of [...sinks]) sink(entry)
    },
    subscribeSpy,
    disposeSpies,
  }
}

/** Fake `onHostChanged` registration point: models the standalone window's
 *  open/close signal (`hostWc` non-null when open/rebuilt, null when
 *  closed). */
function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void
  fire: (hostWc: WebContents | null) => void
  registerSpy: ReturnType<typeof vi.fn>
  unregisterSpy: ReturnType<typeof vi.fn>
} {
  let handler: ((hostWc: WebContents | null) => void) | null = null
  const unregisterSpy = vi.fn()
  const registerSpy = vi.fn((h: (hostWc: WebContents | null) => void) => {
    handler = h
    return unregisterSpy
  })
  return {
    onHostChanged: registerSpy,
    fire: (hostWc) => {
      if (!handler) throw new Error('onHostChanged handler was never registered')
      handler(hostWc)
    },
    registerSpy,
    unregisterSpy,
  }
}

describe('createGlobalDiagnosticsMirror — installation', () => {
  it('registers an onHostChanged handler exactly once at install time, without subscribing to the bus yet (window not open)', () => {
    const { bus, subscribeSpy } = makeFakeDiagnosticsBus()
    const { onHostChanged, registerSpy } = makeHostChangedController()
    const { wc: target } = makeWc()

    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy).not.toHaveBeenCalled()
  })
})

describe('createGlobalDiagnosticsMirror — opening the window replays history into target (THE reported bug)', () => {
  it('subscribes to the bus with {replay:true} exactly once when the host becomes non-null', () => {
    const { bus, subscribeSpy } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)

    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy.mock.calls[0]?.[1]).toEqual({ replay: true })
  })

  // This is the exact scenario reported as the bug: compile-standby (or any
  // main-synthesized diagnostic) fires at app boot, long before the user has
  // ever opened the "debug the whole Electron app" window. Under the old
  // design (subscribe once at app.ts wiring time) the replay this triggered
  // found no live target and the diagnostic was silently dropped. It must
  // now surface the first time the window is opened, however much later.
  it('delivers a diagnostic reported before the window was EVER opened, the first time the window opens (reproduces the reported bug)', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()

    // App boots; compile-standby reports before the standalone window has
    // ever been constructed, let alone opened.
    report({ severity: 'info', code: 'compile-standby', message: 'compile standby spawned pid=89193', audience: 'internal' })

    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain('compile standby spawned pid=89193')
  })

  it('replays multiple diagnostics buffered before the first open, in original order', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()

    report({ severity: 'info', code: 'compile-standby', message: 'm1', audience: 'internal' })
    report({ severity: 'error', code: 'page-not-found', message: 'm2', audience: 'user' })

    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(2)
    expect(String(exec.mock.calls[0]![0])).toContain('m1')
    expect(String(exec.mock.calls[1]![0])).toContain('m2')
  })

  it('injects into `target`, not the hostWc carried by the open/close signal', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec: targetExec } = makeWc()
    const { wc: host, exec: hostExec } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })
    await flushMicrotasks()

    expect(targetExec).toHaveBeenCalled()
    expect(hostExec).not.toHaveBeenCalled()
  })

  it('does not filter by audience — both internal and user diagnostics reach target, in emission order', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)

    report({ severity: 'info', code: 'compile-standby', message: 'internal one', audience: 'internal' })
    report({ severity: 'error', code: 'page-not-found', message: 'user one', audience: 'user' })
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(2)
    expect(String(exec.mock.calls[0]![0])).toContain('internal one')
    expect(String(exec.mock.calls[1]![0])).toContain('user one')
  })
})

describe('createGlobalDiagnosticsMirror — closing the window pauses consumption; reopening re-replays (regression for the exact reported bug)', () => {
  it('disposes the live bus subscription when the host becomes null', () => {
    const { bus, disposeSpies } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    fire(null)

    expect(disposeSpies).toHaveLength(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('does not inject diagnostics reported while the window is closed', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    fire(null)
    exec.mockClear()
    report({ severity: 'warn', code: 'app-config-unreachable', message: 'while closed', audience: 'internal' })
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })

  it('reopening re-subscribes with {replay:true} and delivers diagnostics reported while the window was closed', async () => {
    const { bus, report, subscribeSpy } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    fire(null)
    report({ severity: 'error', code: 'page-not-found', message: 'reported while closed', audience: 'user' })
    exec.mockClear()

    fire(host)
    await flushMicrotasks()

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(subscribeSpy.mock.calls[1]?.[1]).toEqual({ replay: true })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain('reported while closed')
  })
})

describe('createGlobalDiagnosticsMirror — reopen does not double-inject already-shown diagnostics (regression for the real reported duplicate-log bug)', () => {
  // Same root cause as createGlobalConsoleMirror's equivalent block: Chromium's
  // own ConsoleMessageStorage natively re-delivers on reopen, so this mirror's
  // own {replay:true} re-subscription must not ALSO re-inject a diagnostic it
  // already injected once — only diagnostics reported while closed (never
  // physically injected before) may trigger a fresh injection on reopen.
  it('a diagnostic injected during the first open is NOT re-injected when the window is closed and reopened with nothing new reported', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'shown once', audience: 'internal' })
    await flushMicrotasks()
    expect(exec).toHaveBeenCalledTimes(1)
    exec.mockClear()

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })

  it('after a close, only a diagnostic reported WHILE closed is injected on reopen — the pre-existing one stays silent', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'old', audience: 'internal' })
    await flushMicrotasks()
    exec.mockClear()

    fire(null)
    report({ severity: 'error', code: 'page-not-found', message: 'new while closed', audience: 'user' })
    fire(host)
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain('new while closed')
  })
})

describe('createGlobalDiagnosticsMirror — settled/destroyed target gate', () => {
  it('does not inject into a destroyed target (does not throw)', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc({ destroyed: true })
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    expect(() => report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })).not.toThrow()
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })

  it('does not inject into a target whose front-end has not finished loading yet (unsettled)', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc({ loading: true, url: 'devtools://devtools/bundled/devtools_app.html' })
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
  })
})

describe('createGlobalDiagnosticsMirror — dispose', () => {
  it('unregisters the host-changed listener and disposes any live bus subscription', () => {
    const { bus, disposeSpies } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire, unregisterSpy } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const mirror = createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    fire(host)
    mirror.dispose()

    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('dispose is safe to call when the window was never opened (no live subscription to dispose)', () => {
    const { bus } = makeFakeDiagnosticsBus()
    const { onHostChanged, unregisterSpy } = makeHostChangedController()
    const { wc: target } = makeWc()
    const mirror = createGlobalDiagnosticsMirror(bus, target, onHostChanged)

    expect(() => mirror.dispose()).not.toThrow()
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
  })
})

describe('createGlobalDiagnosticsMirror — severity mapping and format', () => {
  it.each([
    ['error', 'console.error'],
    ['warn', 'console.warn'],
    ['info', 'console.info'],
  ] as const)('maps severity:%s to %s in the injected script', async (severity, call) => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)

    report({ severity, code: 'x', message: 'm', audience: 'internal' })
    await flushMicrotasks()

    expect(String(exec.mock.calls[0]![0])).toContain(call)
  })

  it('prefixes the injected message with "[dimina-kit] "', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)

    report({ severity: 'info', code: 'compile-standby', message: 'compile standby spawned pid=89193', audience: 'internal' })
    await flushMicrotasks()

    const script = String(exec.mock.calls[0]![0])
    expect(script).toContain('[dimina-kit]')
    expect(script).toContain('compile standby spawned pid=89193')
  })

  it('calls executeJavaScript with the "run in isolated world" flag (matches console-forward\'s diagnostic-injection contract)', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged)
    fire(host)

    report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledWith(expect.any(String), true)
  })
})
