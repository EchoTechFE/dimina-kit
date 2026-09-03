/**
 * The ledger of host-registered simulator UI extensions.
 *
 * A registration is app-level — the host makes it once — but an extension can
 * only exist inside a PROJECT window: it mounts into that window's device
 * frame and talks to its simulator renderer. So one registration becomes one
 * live extension per project window, and the ledger is what keeps those copies
 * in step with the windows: every project window that opens gets its own copy,
 * and a copy exists exactly as long as the window that owns it.
 *
 * The project list is deliberately not a target. It runs no bridge router and
 * no simulator, so an extension registered into it could never mount, and
 * `invoke` — which follows the window the user works in — would be answered by
 * that dead copy every time the list window has focus.
 */

import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { assertSimulatorUiExtensionShape } from '../services/simulator/ui-extensions.js'
import type {
  SimulatorUiExtensionHandle,
  SimulatorUiExtensionRegistration,
} from '../../shared/simulator-ui.js'

/**
 * The window surface the ledger needs, described structurally so this module
 * does not import WorkbenchContext (see eslint-workbench-context-gate).
 */
export interface UiExtensionWindow {
  simulatorUiExtensions: {
    register: (registration: SimulatorUiExtensionRegistration) => SimulatorUiExtensionHandle
  }
  registry: { add: (d: Disposable) => Disposable }
}

export interface UiExtensionTargetsDeps<W extends UiExtensionWindow> {
  /** Every open project window, in open order. */
  projectWindows: () => W[]
  /** The project window the user is working in, or null when none is open. */
  activeWindow: () => W | null
}

export interface UiExtensionTargets<W extends UiExtensionWindow> {
  /** Give a freshly opened project window its copy of every registration. */
  attachTo: (window: W) => void
  register: (registration: SimulatorUiExtensionRegistration) => SimulatorUiExtensionHandle
}

export function createUiExtensionTargets<W extends UiExtensionWindow>(
  deps: UiExtensionTargetsDeps<W>,
): UiExtensionTargets<W> {
  interface Target { window: W; extension: SimulatorUiExtensionHandle; owned: Disposable }
  /** Per registration, one target per project window that currently holds it. */
  const ledger = new Map<SimulatorUiExtensionRegistration, Target[]>()
  /** Ids currently spoken for app-wide, so a clash is caught where it happens. */
  const ids = new Set<string>()

  function attach(
    window: W,
    targets: Target[],
    registration: SimulatorUiExtensionRegistration,
  ): void {
    const extension = window.simulatorUiExtensions.register(registration)
    // Owned by the window: its registry drives this on close, which both tears
    // the extension down and drops the record. A record left behind would keep
    // a disposed extension reachable as an `invoke` target and would make the
    // ledger grow with every window ever opened.
    const owned = window.registry.add(toDisposable(async () => {
      const index = targets.findIndex((t) => t.extension === extension)
      if (index >= 0) targets.splice(index, 1)
      await extension.dispose()
    }))
    targets.push({ window, extension, owned })
  }

  /**
   * A window refusing an extension is a fact about that window: the project
   * still opens, the other windows keep their copies, and windows opened later
   * still get theirs. Letting it escape would turn one bad extension into "no
   * project can be opened any more".
   */
  function tryAttach(
    window: W,
    targets: Target[],
    registration: SimulatorUiExtensionRegistration,
  ): void {
    try {
      attach(window, targets, registration)
    } catch (error) {
      console.warn(
        `[simulator-ui] project window did not take extension "${registration.id}":`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return {
    attachTo: (window) => {
      for (const [registration, targets] of ledger) tryAttach(window, targets, registration)
    },
    register: (registration) => {
      // Checked here, before anything is recorded: the ledger owns the
      // app-level set of registrations, and hosts register in `onSetup` where
      // there is no project window to do the checking. A rejected registration
      // must leave no record — otherwise it is handed to every project window
      // opened afterwards and takes each of them down as it is built.
      // Snapshotted before anything reads it: the ledger outlives this call and
      // hands the registration to every project window opened later, so a host
      // that reuses its object to describe the next extension would otherwise
      // rewrite what an already-registered one means — the id it releases, and
      // the extension future windows are given.
      const snapshot: SimulatorUiExtensionRegistration = { ...registration }
      assertSimulatorUiExtensionShape(snapshot)
      const id = snapshot.id
      if (ids.has(id)) {
        throw new Error(`Simulator UI extension "${id}" is already registered`)
      }
      const targets: Target[] = []
      ids.add(id)
      ledger.set(snapshot, targets)
      for (const window of deps.projectWindows()) tryAttach(window, targets, snapshot)
      return {
        dispose: () => {
          // Only while this registration is the one holding the id: a second
          // dispose must not free an id a later registration now owns.
          if (!ledger.delete(snapshot)) return
          ids.delete(id)
          // Copied: disposing a window-owned record splices it out of `targets`.
          for (const target of [...targets]) void target.owned.dispose()
          targets.length = 0
        },
        invoke: (method, params) => {
          const active = deps.activeWindow()
          const target = targets.find((t) => t.window === active) ?? targets[targets.length - 1]
          if (!target) throw new Error('simulator UI extension has no live window')
          return target.extension.invoke(method, params)
        },
      }
    },
  }
}
