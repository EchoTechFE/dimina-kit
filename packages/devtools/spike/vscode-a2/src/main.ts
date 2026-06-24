/**
 * Minimal VS Code A2 workbench bootstrap for the death-line spike.
 *
 * Goal: render a workbench shell + start the web extension host worker so we can
 * prove (via the harness CDP probe) that the ext-host is alive and language
 * features work. Exposes window.__A2_STATUS / window.__A2_ERROR for the probe.
 *
 * v34 (@codingame/monaco-vscode-api@34): the worker extension host needs all of
 *   (1) getExtensionServiceOverride({ enableWorkerExtensionHost: true })
 *   (2) the `extensionHostWorkerMain` entry in MonacoEnvironment
 *   (3) `import 'vscode/localExtensionHost'`
 */
import 'vscode/localExtensionHost'

import { initialize as initializeMonacoService } from '@codingame/monaco-vscode-api'
import getExtensionServiceOverride, { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getFilesServiceOverride from '@codingame/monaco-vscode-files-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import { registerExtension, ExtensionHostKind as ExtKind } from '@codingame/monaco-vscode-api/extensions'
import {
  getService,
  IFileService,
  ICommandService,
  ILanguageService,
  IWorkspaceContextService,
} from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'

import {
  WORKSPACE_FILE_ROOT,
  mirrorDiskToFileWorkspace,
  flushFileWorkspaceSaveToDisk,
} from './file-workspace'
import { registerWxmlLanguage } from './wxml-language'
import {
  WXML_LANGUAGE_CONFIGURATION,
  WXML_TMGRAMMAR,
  jsonBlobUrl,
} from './wxml-grammar'
import { DIMINA_DTS } from './dimina-dts'
import {
  DIMINA_SIDEBAR_MANIFEST,
  diminaSidebarFileUrls,
  registerDiminaSidebar,
} from './dimina-sidebar'
import { registerContributedExtensions } from './contributed-extensions'
import { registerDiminaJsonSchemas, applyDiminaJsonSchemaConfig } from './dimina-json-schemas'

// Force the ext-host worker entry into its OWN chunk. Under rolldown-vite the
// static `new URL('…extensionHost.worker', import.meta.url)` form gets inlined
// into the main bundle instead of emitted as a worker, so its bare relative
// `import '../vscode/…/extensionHostWorkerMain.js'` reaches the iframe blob
// `import()` with no hierarchical base → it fails to start. The explicit
// `?worker&url` suffix makes Vite emit a discrete worker asset + give its URL.
import extHostWorkerUrl from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url'
// Same rolldown caveat applies to the editor + TextMate workers: their v34 entry
// points are bare package subpaths, so the `?worker&url` suffix is required for
// Vite to emit discrete worker assets (otherwise the page tries to resolve a bare
// specifier at runtime and the worker fails to start).
import editorWorkerUrl from '@codingame/monaco-vscode-api/workers/editor.worker?worker&url'
import textmateWorkerUrl from '@codingame/monaco-vscode-textmate-service-override/worker?worker&url'

// Built-in extensions (offline-safe; run inside the ext-host worker).
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
// JS/TS language definitions (id + grammar) — without these `.js` files fall to
// plaintext and the TS service never engages.
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
// TS/JS language features in the worker ext-host → drives `.js` IntelliSense
// (dd/wx completion via the seeded dimina.d.ts).
import '@codingame/monaco-vscode-typescript-language-features-default-extension'

declare global {
  interface Window {
    __A2_STATUS?: string
    __A2_ERROR?: string
    __A2_EXTHOST?: unknown
    __A2_WXML?: string
    __A2_DTS?: string
    __A2_CONTRIB?: string
    /** Spike-only probe surface so the harness can drive services without bare-specifier imports in page context. */
    __A2_PROBE?: {
      vscode: typeof import('vscode')
      getService: typeof getService
      IFileService: typeof IFileService
      ICommandService: typeof ICommandService
      ILanguageService: typeof ILanguageService
      IWorkspaceContextService: typeof IWorkspaceContextService
      URI: typeof URI
      VSBuffer: typeof VSBuffer
    }
    MonacoEnvironment?: unknown
  }
}

// Worker URL + options per label. The web extension host is created INSIDE the
// `webWorkerExtensionHostIframe.html` iframe, whose own MonacoEnvironment is
// distinct from this page's — so the `extensionHostWorkerMain` worker must be
// wired through the host's iframe bootstrap (EnvironmentOverride), not just
// here. This page-level map covers the editor + textmate workers.
const workers: Record<string, { url: URL; options?: WorkerOptions }> = {
  editorWorkerService: {
    url: new URL(editorWorkerUrl, import.meta.url),
    options: { type: 'module' },
  },
  extensionHostWorkerMain: {
    url: new URL(extHostWorkerUrl, import.meta.url),
    options: { type: 'module' },
  },
  TextMateWorker: {
    url: new URL(textmateWorkerUrl, import.meta.url),
    options: { type: 'module' },
  },
}

window.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string): string | undefined {
    return workers[label]?.url.toString()
  },
  getWorkerOptions(_moduleId: string, label: string): WorkerOptions | undefined {
    return workers[label]?.options
  },
}

// The page is served from the COI server root, so its origin is the fs bridge base.
const FS_BASE_URL = location.origin + '/'

async function boot(): Promise<void> {
  const container = document.getElementById('workbench')!

  const overrides = {
    ...getLogServiceOverride(),
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getModelServiceOverride(),
    ...getFilesServiceOverride(),
    ...getThemeServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getStorageServiceOverride(),
    ...getQuickAccessServiceOverride(),
    ...getWorkbenchServiceOverride(),
  }

  // The workspace folder is the `file://` memfs root (tsserver-friendly). The
  // disk project is mirrored into it after initialize; saves flush back to disk.
  const folderUri = URI.parse(WORKSPACE_FILE_ROOT)

  window.__A2_STATUS = 'initializing'
  await initializeMonacoService(overrides, container, {
    productConfiguration: {
      // No extensionsGallery → no network/marketplace fetch (offline-safe).
      nameShort: 'A2 Spike',
      nameLong: 'A2 Spike Workbench',
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
  window.__A2_STATUS = 'service-initialized'

  // Built-in WXML language extension: contributes the `wxml` language id +
  // TextMate grammar + language-configuration. Runs as a system extension so it
  // needs no marketplace. Files are served as blob URLs (offline-safe).
  try {
    const wxmlExt = registerExtension(
      {
        name: 'wxml-language-features',
        publisher: 'dimina',
        version: '1.0.0',
        engines: { vscode: '*' },
        contributes: {
          languages: [
            {
              id: 'wxml',
              aliases: ['WXML', 'wxml'],
              extensions: ['.wxml'],
              configuration: './language-configuration.json',
            },
          ],
          grammars: [
            {
              language: 'wxml',
              scopeName: 'text.html.wxml',
              path: './wxml.tmLanguage.json',
            },
          ],
        },
      } as never,
      ExtKind.LocalWebWorker,
      { system: true },
    )
    if ('registerFileUrl' in wxmlExt) {
      wxmlExt.registerFileUrl('./language-configuration.json', jsonBlobUrl(WXML_LANGUAGE_CONFIGURATION), {
        mimeType: 'application/json',
      })
      wxmlExt.registerFileUrl('./wxml.tmLanguage.json', jsonBlobUrl(WXML_TMGRAMMAR), {
        mimeType: 'application/json',
      })
    }
    await wxmlExt.whenReady()
  } catch (e) {
    console.error('[a2-spike] wxml extension registration failed', e)
  }

  // Dimina-specific sidebar: Activity Bar view container + Pages / App Config
  // tree views. Registered as a system web extension (manifest + blob file URLs)
  // like the wxml extension; the providers are attached against the page-side
  // vscode API below once it is bound.
  try {
    const diminaExt = registerExtension(DIMINA_SIDEBAR_MANIFEST as never, ExtKind.LocalWebWorker, { system: true })
    if ('registerFileUrl' in diminaExt) {
      for (const f of diminaSidebarFileUrls()) {
        diminaExt.registerFileUrl(f.path, f.url, { mimeType: f.mimeType })
      }
    }
    await diminaExt.whenReady()
  } catch (e) {
    console.error('[a2-spike] dimina sidebar extension registration failed', e)
  }

  // Registering an extension forces the worker ext-host to spin up + binds the
  // `vscode` API. Activation proves the ext-host worker is alive.
  const { getApi } = await registerExtension(
    {
      name: 'a2-spike',
      publisher: 'dimina',
      version: '1.0.0',
      engines: { vscode: '*' },
      main: 'extension.js',
      activationEvents: ['*'],
    },
    ExtensionHostKind.LocalProcess,
    { system: false },
  )

  // Attach WXML completion/hover providers against the page-side vscode API.
  try {
    const api = await getApi()
    registerWxmlLanguage(api)
    // Dimina sidebar tree views + open-page command (reads file:///workspace/app.json).
    try {
      registerDiminaSidebar(api)
    } catch (e) {
      console.error('[a2-spike] dimina sidebar providers failed', e)
    }
    // Dimina config-file JSON schemas (app.json / page *.json / project.config.json).
    try {
      registerDiminaJsonSchemas(api)
      void applyDiminaJsonSchemaConfig(api)
    } catch (e) {
      console.error('[a2-spike] dimina json schemas failed', e)
    }
    window.__A2_PROBE = {
      vscode: api,
      getService,
      IFileService,
      ICommandService,
      ILanguageService,
      IWorkspaceContextService,
      URI,
      VSBuffer,
    }
    window.__A2_WXML = 'registered'
  } catch (e) {
    window.__A2_WXML = 'failed: ' + String(e)
    console.error('[a2-spike] wxml language providers failed', e)
  }

  // Downstream editor extensibility: load host-contributed web extensions served
  // by the COI server at /__contrib (no-op when the host configured none).
  try {
    const n = await registerContributedExtensions()
    window.__A2_CONTRIB = 'loaded:' + n
  } catch (e) {
    window.__A2_CONTRIB = 'failed: ' + String(e)
    console.error('[a2-spike] contributed extensions failed', e)
  }

  // Mirror the disk project into file:///workspace + seed dd/wx ambient typings,
  // then keep saves flushed back to disk. The file:// root is what makes the web
  // tsserver load jsconfig + dimina.d.ts so `dd.`/`wx.` resolve (a custom scheme
  // root yields an inferred project that ignores both → `dd` is `any`).
  try {
    const fileService = await getService(IFileService)
    const mirrored = await mirrorDiskToFileWorkspace(FS_BASE_URL)

    const dtsUri = URI.parse(`${WORKSPACE_FILE_ROOT}/dimina.d.ts`)
    await fileService.writeFile(dtsUri, VSBuffer.fromString(DIMINA_DTS))
    // jsconfig with the ambient d.ts in `files` forces a ConfiguredProject that
    // always includes the dd/wx globals.
    const jsconfigUri = URI.parse(`${WORKSPACE_FILE_ROOT}/jsconfig.json`)
    await fileService.writeFile(
      jsconfigUri,
      VSBuffer.fromString(
        JSON.stringify(
          {
            compilerOptions: {
              allowJs: true,
              checkJs: false,
              target: 'es2020',
              module: 'commonjs',
              lib: ['es2020', 'dom'],
            },
            files: ['dimina.d.ts'],
            include: ['**/*.js'],
          },
          null,
          2,
        ),
      ),
    )

    // Flush every WRITE/CREATE under the workspace back to disk (keeps editing
    // real). FileOperation.WRITE === 4, CREATE === 0.
    fileService.onDidRunOperation(async (e) => {
      if (e.operation !== 4 && e.operation !== 0) return
      try {
        const content = await fileService.readFile(e.resource)
        await flushFileWorkspaceSaveToDisk(FS_BASE_URL, e.resource, content.value.buffer)
      } catch {
        // best-effort flush; non-workspace resources are ignored by the flusher
      }
    })

    window.__A2_DTS = 'written:' + mirrored
  } catch (e) {
    window.__A2_DTS = 'failed: ' + String(e)
    console.error('[a2-spike] file:// mirror + d.ts seed failed', e)
  }

  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.remove()
  window.__A2_STATUS = 'workbench-ready'

  // Decisive ext-host liveness proof: registering a command + executing it only
  // succeeds if the worker extension host actually activated (commands round-trip
  // through the ext-host). Also count loaded extensions (JSON/theme run there).
  try {
    const vscode = await import('vscode')
    let pingResult: unknown = null
    const disp = vscode.commands.registerCommand('a2spike.ping', () => 'pong-from-exthost')
    void disp
    pingResult = await vscode.commands.executeCommand('a2spike.ping')
    const extCount = vscode.extensions.all.length
    window.__A2_EXTHOST = { ping: pingResult, extCount }
    window.__A2_STATUS = pingResult === 'pong-from-exthost' ? 'exthost-alive' : 'exthost-no-pong'
  } catch (e) {
    window.__A2_EXTHOST = { error: String(e) }
    window.__A2_STATUS = 'exthost-probe-failed'
  }
}

boot().catch((err) => {
  window.__A2_ERROR = String(err && (err as Error).stack ? (err as Error).stack : err)
  window.__A2_STATUS = 'error'
  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.textContent = 'A2 boot error: ' + window.__A2_ERROR
  console.error('[a2-spike] boot failed', err)
})
