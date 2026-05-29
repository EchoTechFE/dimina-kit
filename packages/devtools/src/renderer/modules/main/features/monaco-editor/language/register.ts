/**
 * Register dimina mini-program languages with Monaco.
 *
 *   - `wxml` — fresh language id + Monarch tokenizer + hand-written
 *     completion/hover providers (`wxml-lsp.ts`). WeChat-style.
 *   - `wxss` — mapped to Monaco's built-in `css` mode (tokenizer +
 *     worker-backed validation/completion ship with `monaco-editor`),
 *     matching WeChat DevTools which treats `.wxss` as CSS. `rpx` is an
 *     unknown unit (no error, no special token) — acceptable parity.
 *
 * `languageForPath()` is the single source of truth for "which Monaco
 * language id does this file use", consumed by the editor when creating
 * models.
 */
import * as monaco from 'monaco-editor'
import { wxmlMonarchLanguage, wxmlLanguageConfiguration } from './wxml-monarch'
import { registerWxmlLanguageProviders } from './wxml-lsp'

let registered = false

/** Register dimina languages with Monaco. Idempotent. */
export function ensureDiminaLanguages(): void {
  if (registered) return
  registered = true

  monaco.languages.register({ id: 'wxml', extensions: ['.wxml'], aliases: ['WXML', 'wxml'] })
  monaco.languages.setMonarchTokensProvider('wxml', wxmlMonarchLanguage)
  monaco.languages.setLanguageConfiguration('wxml', wxmlLanguageConfiguration)
  registerWxmlLanguageProviders()
}

/** Map a project file path to a Monaco language id. */
export function languageForPath(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.wxml')) return 'wxml'
  if (lower.endsWith('.wxss')) return 'css'
  if (lower.endsWith('.wxs')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.less')) return 'less'
  if (lower.endsWith('.scss')) return 'scss'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  return 'plaintext'
}
