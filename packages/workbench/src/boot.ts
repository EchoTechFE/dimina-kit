/**
 * Reusable VS Code workbench bootstrap (@codingame/monaco-vscode-api@34).
 *
 * `bootWorkbench(options)` renders the workbench shell, starts the web extension
 * host worker, registers the dimina language features, and populates the editor
 * from a pluggable {@link WorkspaceSource}. Hosts differ only in that source
 * (disk-mirror vs in-memory seed) and a few toggles — everything else (service
 * overrides, worker wiring, user config, auto-save, theming) lives here.
 *
 * v34 worker extension host needs all of:
 *   (1) getExtensionServiceOverride({ enableWorkerExtensionHost: true })
 *   (2) the `extensionHostWorkerMain` entry in MonacoEnvironment
 *   (3) `import 'vscode/localExtensionHost'`
 */
import 'vscode/localExtensionHost'

import { initialize as initializeMonacoService } from '@codingame/monaco-vscode-api'
import getExtensionServiceOverride, { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import getConfigurationServiceOverride, {
  updateUserConfiguration,
} from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getStorageServiceOverride, { StorageScope } from '@codingame/monaco-vscode-storage-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getFilesServiceOverride from '@codingame/monaco-vscode-files-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getSnippetsServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import { registerExtension, ExtensionHostKind as ExtKind } from '@codingame/monaco-vscode-api/extensions'
import {
  getService,
  IFileService,
  ICommandService,
  ILanguageService,
  IWorkspaceContextService,
  ITextFileService,
} from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { InMemoryStorageDatabase } from '@codingame/monaco-vscode-api/vscode/vs/base/parts/storage/common/storage'

import { TYPES_ROOT } from './file-workspace'
import { registerWxmlLanguage } from './wxml-language'
import { WXML_LANGUAGE_CONFIGURATION, WXML_TMGRAMMAR, jsonBlobUrl } from './wxml-grammar'
import { seedAmbientTypings, type ExtraTyping } from './typings-injection'
import { registerContributedExtensions } from './contributed-extensions'
import { registerDiminaJsonSchemas } from './dimina-json-schemas'
import { buildFileAssociations, type CustomFileTypes } from './file-type-associations'
import type { WorkspaceSource } from './workspace/types'

// Worker asset URLs + `window.MonacoEnvironment` wiring (a bundler concern with
// rolldown-vite caveats of its own) live in their own module.
import { installMonacoEnvironment } from './monaco-environment'

// Built-in extensions (offline-safe; run inside the ext-host worker).
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
// CSS language (id + grammar + IntelliSense) — `.wxss` is associated with `css`
// (see buildUserConfig) so stylesheet files highlight instead of falling to plaintext.
import '@codingame/monaco-vscode-css-default-extension'
// JS/TS language definitions (id + grammar) — without these `.js` files fall to
// plaintext and the TS service never engages.
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
// TS/JS language features in the worker ext-host → drives `.js` IntelliSense
// (dd/wx completion via the seeded dimina.d.ts).
import '@codingame/monaco-vscode-typescript-language-features-default-extension'

/** Probe surface exposed (opt-in) so a CDP harness can drive services. */
export interface WorkbenchProbe {
  vscode: typeof import('vscode')
  getService: typeof getService
  IFileService: typeof IFileService
  ICommandService: typeof ICommandService
  ILanguageService: typeof ILanguageService
  IWorkspaceContextService: typeof IWorkspaceContextService
  /** Dirty-buffer check — used by a host's `applyToEditor` (wal-audit.ts's disk
   * sync engine) to skip refreshing a file the user has unsaved edits in. */
  ITextFileService: typeof ITextFileService
  URI: typeof URI
  VSBuffer: typeof VSBuffer
}

declare global {
  interface Window {
    __WB_PROBE?: WorkbenchProbe
  }
}

/** Dimina language features. Default: all on (the full devtools editor). */
export interface WorkbenchFeatures {
  /** WXML language id + grammar + completion/hover providers. */
  wxml?: boolean
  /** app.json / page *.json / project.config.json JSON schemas. */
  jsonSchemas?: boolean
  /** Seed dd/wx ambient `.d.ts` so `dd.`/`wx.` resolve in `.js`. */
  ambientTypings?: boolean
  /** Load host-contributed web extensions served at `/__contrib`. */
  contributedExtensions?: boolean
}

export interface BootWorkbenchOptions {
  /** The mount element (filled with the workbench shell). */
  container: HTMLElement
  /** Where the editor's files come from (disk-mirror / in-memory seed). */
  workspace: WorkspaceSource
  /** Initial color scheme (default `dark`). */
  theme?: 'light' | 'dark'
  /** `productConfiguration` name overrides shown in the workbench chrome. */
  product?: { nameShort?: string; nameLong?: string }
  /** Per-feature toggles; omitted features default to enabled. */
  features?: WorkbenchFeatures
  /**
   * Host-configured custom file types (e.g. `.qdml`/`.qdss`/`.qds`). Same shape
   * as the dmcc compiler's `build()` `options.fileTypes`; mapped to
   * `files.associations` so brand extensions highlight as wxml/css/javascript.
   */
  fileTypes?: CustomFileTypes
  /** Expose `window.__WB_PROBE` for a CDP harness (default false). */
  exposeProbe?: boolean
  /** Lifecycle status callback (`initializing` → `exthost-alive`/error). */
  onStatus?: (status: string) => void
}

export interface WorkbenchHandle {
  /** Re-apply the full user config at a new color scheme. Idempotent. */
  setTheme(scheme: 'light' | 'dark'): void
  /** The page-side `vscode` extension API. */
  vscode: typeof import('vscode')
}

// Built-in theme ids contributed by
// `@codingame/monaco-vscode-theme-defaults-default-extension` (its
// resources/package.json `contributes.themes[].id`). These are the modern VS
// Code defaults and exist offline, so `workbench.colorTheme` resolves without a
// marketplace fetch.
const WORKBENCH_THEME_ID = { light: 'Light Modern', dark: 'Dark Modern' } as const

/**
 * Full user `settings.json` for the embedded editor. `updateUserConfiguration`
 * REPLACES the whole user config, so every setting the workbench needs lives
 * here and is re-applied together on each theme flip:
 *  - `workbench.colorTheme` mirrors the host light/dark scheme.
 *  - `files.associations` maps `.wxss`→css and `.wxs`→javascript so those files
 *    highlight (no dedicated wxss/wxs grammar is bundled; css/js are close), plus
 *    any host custom file types (`.qdml`→wxml / `.qdss`→css / `.qds`→javascript).
 *  - command center, layout controls, and the custom title bar are turned off —
 *    that standalone-window chrome is redundant inside a docked editor panel.
 *  - `files.exclude` hides the `node_modules/` folder that holds the injected
 *    `@types/*` ambient packages. Hiding is UI-only — tsserver still reads them.
 *  - `files.autoSave` (afterDelay) is the contract a save round-trips through
 *    `WorkspaceSource.onSave` without ⌘S (this is a live-preview editor). The
 *    setting alone is inert here: monaco-vscode-api's default service set never
 *    registers the `EditorAutoSave` contribution, so `installAutoSave` drives it
 *    from public API. `highlightModifiedTabs` keeps the brief dirty window visible.
 */
function buildUserConfig(scheme: 'light' | 'dark', fileTypes?: CustomFileTypes): Record<string, unknown> {
  return {
    'workbench.colorTheme': WORKBENCH_THEME_ID[scheme],
    'files.associations': buildFileAssociations(fileTypes),
    'files.exclude': { 'node_modules': true },
    'files.autoSave': 'afterDelay',
    'files.autoSaveDelay': 1000,
    'workbench.editor.highlightModifiedTabs': true,
    // Open files as permanent tabs, not single-click preview — preview tabs don't
    // render the dirty (●) indicator here, and permanent tabs match the live-edit flow.
    'workbench.editor.enablePreview': false,
    'window.commandCenter': false,
    'workbench.layoutControl.enabled': false,
    'window.customTitleBarVisibility': 'never',
  }
}

/**
 * Drive `files.autoSave: afterDelay` ourselves. monaco-vscode-api's default
 * service set ships the auto-save config keys and the Settings UI, but never
 * imports `editor.contribution._autosave` — so `EditorAutoSave` is unregistered
 * and the `afterDelay` timer never schedules. Without this, an edit stays dirty
 * forever unless the user presses ⌘S, and the live-preview never recompiles.
 *
 * Public API only: debounce `onDidChangeTextDocument` by `files.autoSaveDelay`,
 * then `saveAll(false)` (dirty file-scheme docs only). The save flushes through
 * the file service's WRITE op → `WorkspaceSource.onSave`. `autoSave: 'off'` opts
 * out. A no-op save on already-clean docs is harmless if the contribution is
 * ever wired upstream.
 */
function installAutoSave(vscode: typeof import('vscode')): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== 'file') return
    const cfg = vscode.workspace.getConfiguration('files')
    if (cfg.get<string>('autoSave') === 'off') return
    const delay = Math.max(200, Number(cfg.get('autoSaveDelay')) || 1000)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void vscode.workspace.saveAll(false)
    }, delay)
  })
}

/** Register the WXML language id + TextMate grammar + language-configuration as a system web extension (offline; files served as blob URLs). */
async function registerWxmlExtension(): Promise<void> {
  const wxmlExt = registerExtension(
    {
      name: 'wxml-language-features',
      publisher: 'dimina',
      version: '1.0.0',
      engines: { vscode: '*' },
      contributes: {
        languages: [
          { id: 'wxml', aliases: ['WXML', 'wxml'], extensions: ['.wxml'], configuration: './language-configuration.json' },
        ],
        grammars: [{ language: 'wxml', scopeName: 'text.html.wxml', path: './wxml.tmLanguage.json' }],
      },
    } as never,
    ExtKind.LocalWebWorker,
    { system: true },
  )
  if ('registerFileUrl' in wxmlExt) {
    wxmlExt.registerFileUrl('./language-configuration.json', jsonBlobUrl(WXML_LANGUAGE_CONFIGURATION), {
      mimeType: 'application/json',
    })
    wxmlExt.registerFileUrl('./wxml.tmLanguage.json', jsonBlobUrl(WXML_TMGRAMMAR), { mimeType: 'application/json' })
  }
  await wxmlExt.whenReady()
}

/**
 * Populate the workspace from its source, seed ambient typings, and keep
 * subsequent saves flushed back through `workspace.onSave`. Best-effort: a
 * failure here logs but does not abort boot.
 */
async function populateWorkspace(
  workspace: BootWorkbenchOptions['workspace'],
  seedTypings: boolean,
  contributedTypings: ExtraTyping[],
): Promise<void> {
  try {
    const fileService = await getService(IFileService)
    await workspace.populate(fileService)

    if (seedTypings) {
      await seedAmbientTypings(fileService, contributedTypings)
    }

    if (workspace.onSave) {
      // Flush every WRITE/CREATE under the workspace. FileOperation.WRITE === 4, CREATE === 0.
      fileService.onDidRunOperation(async (e) => {
        if (e.operation !== 4 && e.operation !== 0) return
        try {
          const content = await fileService.readFile(e.resource)
          await workspace.onSave!(e.resource, content.value.buffer)
        } catch {
          // best-effort flush; non-workspace resources are ignored by the source
        }
      })
    }
  } catch (e) {
    console.error('[workbench] workspace populate + d.ts seed failed', e)
  }
}

/**
 * Decisive ext-host liveness proof: registering a command + executing it only
 * succeeds if the worker extension host actually activated (commands round-trip
 * through the ext-host). The probe command is single-shot — disposed in finally
 * so it does not linger in the palette or leak across re-boots.
 */
async function probeExtHostLiveness(
  vscode: typeof import('vscode'),
  status: (s: string) => void,
): Promise<void> {
  let disposable: { dispose: () => void } | undefined
  try {
    disposable = vscode.commands.registerCommand('dimina.workbench.ping', () => 'pong-from-exthost')
    const result = await vscode.commands.executeCommand<string>('dimina.workbench.ping')
    status(result === 'pong-from-exthost' ? 'exthost-alive' : 'exthost-no-pong')
  } catch (e) {
    status('exthost-probe-failed')
    console.error('[workbench] ext-host ping failed', e)
  } finally {
    disposable?.dispose()
  }
}

export async function bootWorkbench(options: BootWorkbenchOptions): Promise<WorkbenchHandle> {
  const { container, workspace } = options
  const features: Required<WorkbenchFeatures> = {
    wxml: options.features?.wxml ?? true,
    jsonSchemas: options.features?.jsonSchemas ?? true,
    ambientTypings: options.features?.ambientTypings ?? true,
    contributedExtensions: options.features?.contributedExtensions ?? true,
  }
  const status = (s: string) => options.onStatus?.(s)
  void TYPES_ROOT

  installMonacoEnvironment()

  const overrides = {
    ...getLogServiceOverride(),
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getModelServiceOverride(),
    ...getFilesServiceOverride(),
    // Standard VS Code Explorer (file tree) view — shows the workspace files.
    ...getExplorerServiceOverride(),
    // Settings UI editor (the gear → Settings opens nothing without it).
    ...getPreferencesServiceOverride(),
    // Round out a real editing experience: Search sidebar, Problems (markers),
    // Output panel, snippets, and Emmet (handy for wxml/wxss).
    ...getSearchServiceOverride(),
    ...getMarkersServiceOverride(),
    ...getOutputServiceOverride(),
    ...getSnippetsServiceOverride(),
    ...getEmmetServiceOverride(),
    ...getThemeServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getLanguagesServiceOverride(),
    // WORKSPACE-scope state (open editors, view state, explorer expansion) is
    // keyed by the workspace identity, which VS Code derives from the folder
    // URI. Every project here mounts at the same constant `file:///workspace`
    // mirror root (file-workspace.ts explains why tsserver needs that), so the
    // "per-workspace" IndexedDB bucket is really ONE bucket shared by all
    // projects: project A's `editorpart.state` gets restored into project B,
    // reopening tabs for files B does not have, each stranded behind the
    // permanent "file was not found" placeholder. State with no valid identity
    // must not outlive the session — keep this scope in memory. (APPLICATION and
    // PROFILE scopes are genuinely global and keep persisting normally.)
    ...getStorageServiceOverride({
      databaseFactories: { [StorageScope.WORKSPACE]: () => new InMemoryStorageDatabase() },
    }),
    ...getQuickAccessServiceOverride(),
    ...getWorkbenchServiceOverride(),
  }

  // The workspace folder is the `file://` memfs root (tsserver-friendly). The
  // source populates it after initialize; saves flush back through onSave.
  const folderUri = URI.parse(workspace.folderUri)

  status('initializing')
  await initializeMonacoService(overrides, container, {
    productConfiguration: {
      // No extensionsGallery → no network/marketplace fetch (offline-safe).
      nameShort: options.product?.nameShort ?? 'Dimina',
      nameLong: options.product?.nameLong ?? 'Dimina Workbench',
    },
    // Open the project as the single workspace folder so the Explorer renders
    // the tree and the tsserver treats it as a real file:// project root.
    workspaceProvider: {
      trusted: true,
      workspace: { folderUri },
      async open() {
        return false
      },
    },
  } as never)
  status('service-initialized')

  // Track the host light/dark scheme. Initial value is options.theme; later
  // flips arrive through the returned handle.setTheme.
  const applyTheme = (scheme: 'light' | 'dark') =>
    void updateUserConfiguration(JSON.stringify(buildUserConfig(scheme, options.fileTypes)))
  applyTheme(options.theme ?? 'dark')

  // Hide the Accounts entry in the activity bar — the embedded editor has no
  // sign-in/sync, so the account avatar is dead chrome. Config can't remove it,
  // so suppress its action item by its stable codicon class.
  const chromeStyle = document.createElement('style')
  chromeStyle.textContent =
    '.monaco-workbench .activitybar .action-item:has(.codicon-accounts-view-bar-icon){display:none!important}'
  document.head.appendChild(chromeStyle)

  if (features.wxml) {
    try {
      await registerWxmlExtension()
    } catch (e) {
      console.error('[workbench] wxml extension registration failed', e)
    }
  }

  // Registering an extension forces the worker ext-host to spin up + binds the
  // `vscode` API. Activation proves the ext-host worker is alive.
  const { getApi } = await registerExtension(
    {
      name: 'dimina-workbench',
      publisher: 'dimina',
      version: '1.0.0',
      engines: { vscode: '*' },
      main: 'extension.js',
      activationEvents: ['*'],
    },
    ExtensionHostKind.LocalProcess,
    { system: false },
  )
  const vscode = await getApi()

  // Attach providers against the page-side vscode API. Each registers
  // independently so one throwing does not skip the siblings.
  if (features.wxml) {
    try {
      registerWxmlLanguage(vscode)
    } catch (e) {
      console.error('[workbench] wxml language providers failed', e)
    }
  }
  if (features.jsonSchemas) {
    // Dimina config-file JSON schemas (app.json / page *.json / project.config.json).
    // Self-contained provider only; the `json.schemas` user-setting path needs the
    // marketplace JSON language-features extension (not bundled) and would throw.
    try {
      registerDiminaJsonSchemas(vscode)
    } catch (e) {
      console.error('[workbench] dimina json schemas failed', e)
    }
  }

  if (options.exposeProbe) {
    window.__WB_PROBE = {
      vscode,
      getService,
      IFileService,
      ICommandService,
      ILanguageService,
      IWorkspaceContextService,
      ITextFileService,
      URI,
      VSBuffer,
    }
  }

  // Downstream editor extensibility: load host-contributed web extensions served
  // at /__contrib (no-op when the host configured none). Also collects any
  // ambient typings they declare, injected alongside the built-in dd/wx typings.
  let contributedTypings: ExtraTyping[] = []
  if (features.contributedExtensions) {
    try {
      const { typings } = await registerContributedExtensions()
      contributedTypings = typings
    } catch (e) {
      console.error('[workbench] contributed extensions failed', e)
    }
  }

  // Populate the workspace + seed ambient typings, then keep saves flushed back.
  await populateWorkspace(workspace, features.ambientTypings, contributedTypings)

  status('workbench-ready')
  installAutoSave(vscode)

  await probeExtHostLiveness(vscode, status)

  return { setTheme: (scheme) => applyTheme(scheme === 'light' ? 'light' : 'dark'), vscode }
}
