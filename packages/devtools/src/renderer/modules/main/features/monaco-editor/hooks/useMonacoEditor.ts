/**
 * Owns a single Monaco editor instance bound to a container element.
 *
 * Sets up the worker environment + dimina languages + theme exactly once
 * (idempotent helpers), creates the editor on mount, and disposes it (and
 * every model it opened) on unmount. Models are cached per file path so
 * re-opening a file preserves its view state and undo stack.
 */
import { useEffect, useMemo, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { installMonacoEnvironment } from '../monaco-env'
import { ensureDiminaLanguages } from '../language/register'
import { applyMonacoTheme, isDarkMode } from '../theme'
import { onThemeChanged } from '@/shared/api'

export interface MonacoController {
  /** Open (or focus) a model for `key`, seeding it with `value` + `language`. */
  openModel(key: string, value: string, language: string): void
  /** Detach the editor and dispose the models owned by this controller. */
  clearModels(): void
  /** Current editor value, or '' when no editor/model. */
  getValue(): string
  /** Re-apply the dimina theme for the given mode. */
  setTheme(isDark: boolean): void
  /**
   * Move the cursor to `line`/`column` (both 1-based) and scroll it into view,
   * focusing the editor. No-op when no editor/model is attached. Used by the
   * "open a console file link in the editor" flow to jump to the logged frame.
   */
  revealPosition(line: number, column?: number): void
  ready(): boolean
}

export function useMonacoEditor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onChange?: (value: string) => void,
): MonacoController {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map())
  const ownedModelsRef = useRef<Set<monaco.editor.ITextModel>>(new Set())
  // A throwaway empty model the editor falls back to when no file is open.
  // Keeping a model attached at all times means Monaco always renders its
  // `.monaco-editor` DOM — `editor.setModel(null)` detaches the view and
  // removes that node, which would leave the editor cell blank until a file
  // is opened (and break any consumer waiting on `.monaco-editor`).
  const placeholderRef = useRef<monaco.editor.ITextModel | null>(null)
  const onChangeRef = useRef(onChange)
  // Keep the latest `onChange` in a ref so the model-content subscription
  // (which reads `onChangeRef.current` lazily) always calls the current
  // callback without re-running the create-once mount effect. Writing the ref
  // in an effect rather than during render keeps render side-effect-free.
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    installMonacoEnvironment()
    ensureDiminaLanguages()
    applyMonacoTheme(isDarkMode())

    const placeholder = monaco.editor.createModel('', 'plaintext')
    placeholderRef.current = placeholder

    const editor = monaco.editor.create(container, {
      model: placeholder,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Re-apply the dimina theme when the color scheme flips. `applyMonacoTheme`
    // only runs once at mount; without this, switching the workbench theme would
    // leave Monaco frozen on its mount-time theme while the rest of the UI flips.
    // The signal comes from main (onThemeChanged) rather than a renderer
    // matchMedia listener: Electron does NOT dispatch the renderer's
    // `prefers-color-scheme` change event for programmatic
    // `nativeTheme.themeSource` flips, so a matchMedia listener never fires for
    // in-app theme switches. main pushes the resolved isDark instead.
    const offThemeChanged = onThemeChanged((isDark) => applyMonacoTheme(isDark))

    // Capture the model collections at setup time. They are created once on
    // mount and never reassigned, so these locals reference the SAME objects
    // the controller mutates — the cleanup tears down exactly what was opened
    // (and avoids reading a possibly-changed ref during teardown).
    const owned = ownedModelsRef.current
    const models = modelsRef.current

    return () => {
      sub.dispose()
      offThemeChanged()
      editor.dispose()
      editorRef.current = null
      for (const m of owned) {
        try { m.dispose() } catch { /* already disposed */ }
      }
      models.clear()
      owned.clear()
      try { placeholder.dispose() } catch { /* already disposed */ }
      placeholderRef.current = null
    }
  }, [containerRef])

  // Create the controller object ONCE with a stable identity. Its methods
  // close over the component-scoped refs (created on mount, never reassigned),
  // so the singleton stays valid for the component's lifetime while letting
  // consumers depend on it without re-running effects on every render.
  const controller = useMemo<MonacoController>(() => ({
    openModel(key, value, language) {
      const editor = editorRef.current
      if (!editor) return
      let model = modelsRef.current.get(key)
      if (!model || model.isDisposed()) {
        const uri = monaco.Uri.file(key)
        // A model for this URI may already exist if a previous editor left
        // it around; reuse it rather than throwing on duplicate URI.
        model = monaco.editor.getModel(uri) ?? undefined
        if (!model) {
          model = monaco.editor.createModel(value, language, uri)
          ownedModelsRef.current.add(model)
        }
        modelsRef.current.set(key, model)
      }
      if (model.getValue() !== value) model.setValue(value)
      if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
      editor.setModel(model)
    },
    clearModels() {
      // Re-attach the always-present placeholder rather than `setModel(null)`,
      // which would detach Monaco's view and remove the `.monaco-editor` DOM
      // node (the editor cell would render blank until the next file opens).
      const placeholder = placeholderRef.current
      if (placeholder && !placeholder.isDisposed()) {
        editorRef.current?.setModel(placeholder)
      }
      for (const model of ownedModelsRef.current) {
        try { model.dispose() } catch { /* already disposed */ }
      }
      modelsRef.current.clear()
      ownedModelsRef.current.clear()
    },
    getValue() {
      return editorRef.current?.getValue() ?? ''
    },
    setTheme(isDark: boolean) {
      applyMonacoTheme(isDark)
    },
    revealPosition(line, column = 1) {
      const editor = editorRef.current
      if (!editor) return
      // Clamp to the model's bounds so a stale/over-long line from a console
      // frame can't land off the document (Monaco would otherwise ignore it).
      const model = editor.getModel()
      const lineCount = model?.getLineCount() ?? 1
      const targetLine = Math.min(Math.max(1, Math.trunc(line) || 1), lineCount)
      const maxCol = model ? model.getLineMaxColumn(targetLine) : 1
      const targetCol = Math.min(Math.max(1, Math.trunc(column) || 1), maxCol)
      const position = { lineNumber: targetLine, column: targetCol }
      editor.setPosition(position)
      editor.revealPositionInCenter(position)
      editor.focus()
    },
    ready() {
      return editorRef.current !== null
    },
  }), [])

  return controller
}
