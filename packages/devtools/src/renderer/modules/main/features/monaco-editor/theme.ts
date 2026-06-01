/**
 * Dimina ↔ Monaco theme bridge.
 *
 * Monaco ships two base themes: `vs` (light) and `vs-dark`. We define two
 * thin dimina variants on those bases so the editor surface visually
 * matches the workbench. `applyMonacoTheme(isDark)` is called once at
 * editor mount and again whenever the workbench theme flips (the renderer
 * already tracks `prefers-color-scheme` / the dimina theme setting).
 */
import * as monaco from 'monaco-editor'

let defined = false

export const DIMINA_LIGHT = 'dimina-light'
export const DIMINA_DARK = 'dimina-dark'

/** Define dimina light/dark Monaco themes. Idempotent. */
export function defineDiminaThemes(): void {
  if (defined) return
  defined = true

  monaco.editor.defineTheme(DIMINA_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
    },
  })

  monaco.editor.defineTheme(DIMINA_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
    },
  })
}

/** Apply the dimina theme matching the current light/dark mode. */
export function applyMonacoTheme(isDark: boolean): void {
  defineDiminaThemes()
  monaco.editor.setTheme(isDark ? DIMINA_DARK : DIMINA_LIGHT)
}

/** Resolve the current dark-mode flag from the document. */
export function isDarkMode(): boolean {
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return true
    if (document.documentElement.dataset.theme === 'dark') return true
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return false
}
