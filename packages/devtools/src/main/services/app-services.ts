import type { BrowserWindow } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { createLocalProjectsProvider } from './projects/local-provider.js'
import { resolveTemplates } from './projects/templates.js'
import { BUILTIN_TEMPLATES } from './projects/builtin-templates.js'
import type { ProjectsProvider, ProjectTemplate } from './projects/types.js'
import {
  createSimulatorApiRegistry,
  type SimulatorApiRegistry,
} from './simulator/custom-apis.js'

/**
 * The services that belong to the whole application rather than to one window.
 *
 * They are all registered or configured ONCE by the host (through
 * `WorkbenchAppConfig` and the `WorkbenchAppInstance` registration methods),
 * so every window context reads the same instance. Anything whose owner is a
 * single window — views, connections, the CDP broker, the workspace — stays on
 * `WorkbenchContext` instead.
 */
export interface AppServices {
  /** Backing store for the project list. One list, shown by every window. */
  projectsProvider: ProjectsProvider
  /** Built-in templates merged with the host's, per `builtinTemplates`. */
  projectTemplates: ProjectTemplate[]
  /**
   * Reference-counted `webContents.id` → live registration count for
   * host-owned BrowserWindows registered as trusted senders. A host window is
   * registered against the app, not against whichever window happened to be
   * open at the time, so the map is shared and every context's sender policy
   * consults the same entries.
   */
  trustedWindowSenderIds: Map<number, number>
  /**
   * Simulator custom APIs registered by the host. The host registers each
   * handler once (in `onSetup`), so the registry is app-wide: a window opened
   * later must answer the same `wx.*` calls as the one that was open during
   * registration.
   */
  simulatorApis: SimulatorApiRegistry
}

export interface CreateAppServicesOptions {
  projectsProvider?: ProjectsProvider
  projectTemplates?: ProjectTemplate[]
  builtinTemplates?: 'all' | 'none' | readonly string[]
}

export function createAppServices(opts: CreateAppServicesOptions = {}): AppServices {
  return {
    projectsProvider: opts.projectsProvider ?? createLocalProjectsProvider(),
    projectTemplates: resolveTemplates(
      BUILTIN_TEMPLATES,
      opts.projectTemplates ?? [],
      opts.builtinTemplates ?? 'all',
    ),
    trustedWindowSenderIds: new Map<number, number>(),
    simulatorApis: createSimulatorApiRegistry(),
  }
}

/**
 * Adds `win.webContents` to the trusted-sender set and returns a Disposable
 * that removes it again.
 *
 * Trust is reference-counted: registering the SAME window N times keeps it
 * trusted until every one of the N returned Disposables has been disposed.
 * Each register bumps the count, each dispose decrements it, and the window is
 * un-trusted only when the count reaches zero.
 *
 * The window's `closed` event short-circuits the ref-count: it deletes the
 * map entry outright (the window is dead, so it must be un-trusted
 * immediately regardless of how many Disposables are still outstanding).
 * After `closed`, disposing any leftover Disposable is a safe no-op — the
 * map entry is already gone, so the decrement finds `undefined` and bails
 * without driving the count negative or resurrecting trust.
 *
 * Each returned Disposable is itself idempotent (`removed` flag), and its
 * `closed` listener removes itself once fired so a long-lived app doesn't
 * accumulate dead listeners on closed windows.
 */
export function registerTrustedWindow(
  services: Pick<AppServices, 'trustedWindowSenderIds'>,
  win: BrowserWindow,
): Disposable {
  const senderId = win.webContents.id
  const counts = services.trustedWindowSenderIds
  counts.set(senderId, (counts.get(senderId) ?? 0) + 1)

  let removed = false
  const onClosed = () => {
    // The window is gone: zero the ref-count for this sender id outright,
    // regardless of any other outstanding registrations for the same window.
    counts.delete(senderId)
    win.removeListener('closed', onClosed)
  }

  function remove() {
    if (removed) return
    removed = true
    win.removeListener('closed', onClosed)
    const count = counts.get(senderId)
    // `undefined` → the entry was already cleared (e.g. by `closed` or by a
    // prior sibling's decrement that hit zero). Nothing to do — never go
    // negative, never resurrect trust.
    if (count === undefined) return
    if (count <= 1) counts.delete(senderId)
    else counts.set(senderId, count - 1)
  }

  win.once('closed', onClosed)
  return toDisposable(remove)
}
