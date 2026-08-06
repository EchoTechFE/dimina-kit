/**
 * `window.MonacoEnvironment` wiring — how the workbench page hands monaco its
 * worker assets.
 *
 * This is a bundler concern, not a boot-sequence concern: every URL here exists
 * only because rolldown-vite needs an explicit `?worker&url` suffix to emit the
 * worker as a discrete asset. Keeping it out of boot.ts means the boot sequence
 * reads as a sequence, and a Vite/monaco upgrade touches one small module.
 */

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

declare global {
  interface Window {
    MonacoEnvironment?: unknown
  }
}

// Worker URL + options per label. The web extension host is created INSIDE the
// `webWorkerExtensionHostIframe.html` iframe, whose own MonacoEnvironment is
// distinct from this page's — so the `extensionHostWorkerMain` worker must be
// wired through the host's iframe bootstrap (EnvironmentOverride), not just
// here. This page-level map covers the editor + textmate workers.
const workers: Record<string, { url: URL; options?: WorkerOptions }> = {
  editorWorkerService: { url: new URL(editorWorkerUrl, import.meta.url), options: { type: 'module' } },
  extensionHostWorkerMain: { url: new URL(extHostWorkerUrl, import.meta.url), options: { type: 'module' } },
  TextMateWorker: { url: new URL(textmateWorkerUrl, import.meta.url), options: { type: 'module' } },
}

export function installMonacoEnvironment(): void {
  // Respect a MonacoEnvironment the host already installed. A SOURCE consumer
  // (e.g. the web client) bundles this package via `file:`, so its monaco/vscode
  // worker assets resolve from a different node_modules than this module's
  // realpath — the `new URL(…, import.meta.url)` worker URLs computed here can
  // then be wrong for the ext-host iframe. Such a host wires the workers from its
  // OWN bundle and sets `window.MonacoEnvironment` before calling bootWorkbench;
  // we must not clobber it. The prebuilt-bundle entry (src/main.ts, devtools)
  // never sets it, so this stays a no-op change there.
  if (window.MonacoEnvironment) return
  window.MonacoEnvironment = {
    getWorkerUrl(_moduleId: string, label: string): string | undefined {
      return workers[label]?.url.toString()
    },
    getWorkerOptions(_moduleId: string, label: string): WorkerOptions | undefined {
      return workers[label]?.options
    },
  }
}
