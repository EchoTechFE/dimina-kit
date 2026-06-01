/// <reference types="vite/client" />
/**
 * Monaco web-worker wiring for Vite.
 *
 * Monaco offloads language services (CSS/JSON/TS/HTML validation +
 * completion) to dedicated web workers. The standalone `monaco-editor`
 * package ships the worker entry points as ESM modules; Vite's `?worker`
 * import turns each into a `Worker` constructor that resolves the bundled
 * chunk URL at build time (works under Electron's file:// renderer because
 * Vite emits real worker chunks, not a CDN reference).
 *
 * `self.MonacoEnvironment.getWorker` MUST be set before any
 * `monaco.editor.create` / `monaco.editor.createModel` call. Import this
 * module first (the language `register.ts` does so transitively).
 *
 * Our own `wxml` language uses hand-written providers on the main thread
 * (see `wxml-lsp.ts`), so it needs no worker — it falls through to the
 * default editor worker.
 */
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

let installed = false

/** Install the Monaco worker resolver. Idempotent. */
export function installMonacoEnvironment(): void {
  if (installed) return
  installed = true
  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'css':
        case 'less':
        case 'scss':
          return new cssWorker()
        case 'json':
          return new jsonWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        default:
          return new editorWorker()
      }
    },
  }
}
