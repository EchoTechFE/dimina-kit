import type { WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  SimulatorUiExtensionHandle,
  SimulatorUiExtensionRegistration,
} from '../../../shared/simulator-ui.js'

interface ExtensionEntry {
  registration: SimulatorUiExtensionRegistration
}

interface ActiveSimulator {
  webContents: WebContents
  ready: boolean
  generation: number
  loaded: Set<string>
  loading: Map<string, Promise<void>>
  onLoaded: () => void
}

export interface SimulatorUiExtensionRegistry {
  register(registration: SimulatorUiExtensionRegistration): SimulatorUiExtensionHandle
  attach(webContents: WebContents): void
  detach(webContents?: WebContents): void
  clear(): void
}

export interface SimulatorUiExtensionRegistryOptions {
  loadSource?: (scriptPath: string) => Promise<string>
}

const EXTENSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The rules a registration has to satisfy on its own, with no window and no
 * renderer involved: the id is a lookup key on both sides of the bridge, and
 * the script is read straight from disk with no base to resolve against. They
 * hold wherever a registration is accepted, so whoever accepts one first is
 * where a host learns it is unusable.
 */
export function assertSimulatorUiExtensionShape(
  registration: SimulatorUiExtensionRegistration,
): void {
  if (!EXTENSION_ID_RE.test(registration.id)) {
    throw new Error(`Invalid simulator UI extension id: "${registration.id}"`)
  }
  if (!isAbsolute(registration.rendererScriptPath)) {
    throw new Error('Simulator UI extension rendererScriptPath must be absolute')
  }
}

export function createSimulatorUiExtensionRegistry(
  options: SimulatorUiExtensionRegistryOptions = {},
): SimulatorUiExtensionRegistry {
  const loadSource = options.loadSource ?? (scriptPath => readFile(scriptPath, 'utf8'))
  const entries = new Map<string, ExtensionEntry>()
  let active: ActiveSimulator | null = null

  function assertRegistration(registration: SimulatorUiExtensionRegistration): void {
    assertSimulatorUiExtensionShape(registration)
    if (entries.has(registration.id)) {
      throw new Error(`Simulator UI extension "${registration.id}" is already registered`)
    }
  }

  function activeExpression(method: string, args: unknown[]): string {
    return `globalThis.__diminaSimulatorUi.${method}(${args.map(arg => JSON.stringify(arg)).join(',')})`
  }

  async function install(entry: ExtensionEntry, target: ActiveSimulator): Promise<void> {
    const { id, rendererScriptPath } = entry.registration
    if (target.loaded.has(id)) return
    const pending = target.loading.get(id)
    if (pending) return await pending
    const generation = target.generation

    const task: Promise<void> = (async () => {
      // Read once per simulator document generation so downstream watch builds
      // become visible after a hard reload without restarting the workbench.
      const source = await loadSource(rendererScriptPath)
      if (
        entries.get(id) !== entry
        ||
        active !== target
        || target.webContents.isDestroyed()
        || !target.ready
        || target.generation !== generation
      ) {
        throw new Error('Simulator UI extension target is no longer available')
      }
      const sourceUrl = pathToFileURL(rendererScriptPath).href
      const wrapped = `(()=>{\n${source}\n;return undefined\n})()\n//# sourceURL=${sourceUrl}`
      await target.webContents.executeJavaScript(wrapped, true)
      if (
        entries.get(id) !== entry
        ||
        active !== target
        || target.webContents.isDestroyed()
        || !target.ready
        || target.generation !== generation
      ) {
        throw new Error('Simulator UI extension target was destroyed during installation')
      }
      const registered = await target.webContents.executeJavaScript(
        `Boolean(globalThis.__diminaSimulatorUi?.has(${JSON.stringify(id)}))`,
        true,
      )
      if (!registered) {
        throw new Error(
          `Simulator UI extension "${id}" did not register its renderer implementation`,
        )
      }
      target.loaded.add(id)
    })().finally(() => {
      if (target.loading.get(id) === task) target.loading.delete(id)
    })

    target.loading.set(id, task)
    return await task
  }

  async function installAll(target: ActiveSimulator): Promise<void> {
    for (const entry of entries.values()) {
      try {
        await install(entry, target)
      } catch (error) {
        console.warn(
          `[simulator-ui] failed to install "${entry.registration.id}":`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  function uninstall(id: string, target = active): void {
    if (!target) return
    target.loaded.delete(id)
    target.loading.delete(id)
    if (!target.ready || target.webContents.isDestroyed()) return
    void target.webContents.executeJavaScript(
      `globalThis.__diminaSimulatorUi?.unregister(${JSON.stringify(id)})`,
      true,
    ).catch(() => { /* simulator is already leaving */ })
  }

  function detach(webContents?: WebContents): void {
    const target = active
    if (!target || (webContents && target.webContents !== webContents)) return
    active = null
    if (!target.webContents.isDestroyed()) {
      target.webContents.removeListener('did-finish-load', target.onLoaded)
    }
    target.loaded.clear()
    target.loading.clear()
  }

  function attach(webContents: WebContents): void {
    detach()
    const target: ActiveSimulator = {
      webContents,
      ready: false,
      generation: 0,
      loaded: new Set<string>(),
      loading: new Map<string, Promise<void>>(),
      onLoaded: () => {},
    }
    target.onLoaded = () => {
      if (active !== target || webContents.isDestroyed()) return
      target.ready = true
      target.generation += 1
      target.loaded.clear()
      target.loading.clear()
      void installAll(target)
    }
    active = target
    webContents.on('did-finish-load', target.onLoaded)
  }

  function register(
    registration: SimulatorUiExtensionRegistration,
  ): SimulatorUiExtensionHandle {
    assertRegistration(registration)
    const stableRegistration = { ...registration }
    const entry: ExtensionEntry = {
      registration: stableRegistration,
    }
    entries.set(stableRegistration.id, entry)

    const target = active
    if (target?.ready) {
      void install(entry, target).catch((error) => {
        console.warn(
          `[simulator-ui] failed to install "${stableRegistration.id}":`,
          error instanceof Error ? error.message : String(error),
        )
      })
    }

    let disposed = false
    return {
      dispose() {
        if (disposed) return
        disposed = true
        if (entries.get(stableRegistration.id) !== entry) return
        entries.delete(stableRegistration.id)
        uninstall(stableRegistration.id)
      },
      async invoke<T>(method: string, params?: unknown): Promise<T> {
        if (disposed || entries.get(stableRegistration.id) !== entry) {
          throw new Error(`Simulator UI extension "${stableRegistration.id}" is disposed`)
        }
        const current = active
        if (!current || current.webContents.isDestroyed() || !current.ready) {
          throw new Error('Dimina simulator UI is not ready')
        }
        await install(entry, current)
        if (active !== current || current.webContents.isDestroyed()) {
          throw new Error('Dimina simulator UI was replaced during invocation')
        }
        return await current.webContents.executeJavaScript(
          activeExpression('invoke', [stableRegistration.id, method, params ?? null]),
          true,
        ) as T
      },
    }
  }

  function clear(): void {
    for (const id of entries.keys()) uninstall(id)
    entries.clear()
    detach()
  }

  return { register, attach, detach, clear }
}
