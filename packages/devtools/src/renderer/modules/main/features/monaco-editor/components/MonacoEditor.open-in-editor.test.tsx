/**
 * Behavior test for the renderer end of the "click a console file link → open
 * in editor" pipeline.
 *
 * Contract pinned here: when the main process broadcasts `editor:openFile`
 * (path + 1-based line/column), <MonacoEditor/> opens that project file (reads
 * it via the sandboxed fs IPC, attaches the model) and reveals the requested
 * position. A path with no position opens the file without moving the cursor.
 *
 * Everything below the component is mocked (fs IPC, Monaco controller, language
 * registration) so the test runs under jsdom with no real Monaco / Electron.
 * The `editor-api` mock hands the test the subscription callback so it can drive
 * a main→renderer `editor:openFile` event the way the IPC layer would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { EditorOpenFilePayload } from '../../../../../../shared/ipc-channels'

// ── fs IPC: a project with two files; reads resolve distinct content. ──
const readProjectFile = vi.fn<(abs: string) => Promise<string>>((abs) =>
  Promise.resolve(`content-of:${abs}`),
)
const listProjectFiles = vi.fn<(root: string) => Promise<string[]>>(() =>
  Promise.resolve(['app.json', 'pages/home/home.js']),
)
vi.mock('../services/file-service', () => ({
  writeProjectFile: () => Promise.resolve(),
  writeProjectFileSync: () => ({ ok: true }),
  readProjectFile: (abs: string) => readProjectFile(abs),
  listProjectFiles: (root: string) => listProjectFiles(root),
  getProjectRoot: () => Promise.resolve(''),
}))

vi.mock('../language/register', () => ({
  ensureDiminaLanguages: () => {},
  languageForPath: () => 'javascript',
}))

// ── editor-api: capture the onEditorOpenFile subscriber so the test fires it. ──
let capturedOpenHandler: ((p: EditorOpenFilePayload) => void) | undefined
vi.mock('@/shared/api', () => ({
  onEditorOpenFile: (handler: (p: EditorOpenFilePayload) => void) => {
    capturedOpenHandler = handler
    return () => { capturedOpenHandler = undefined }
  },
}))

// ── useMonacoEditor: record openModel + revealPosition calls. ──
const openModel = vi.fn<(key: string, value: string, language: string) => void>()
const revealPosition = vi.fn<(line: number, column?: number) => void>()
const stableController = {
  openModel: (k: string, v: string, l: string) => openModel(k, v, l),
  clearModels: () => {},
  getValue: () => '',
  setTheme: () => {},
  revealPosition: (line: number, column?: number) => revealPosition(line, column),
  ready: () => true,
}
vi.mock('../hooks/useMonacoEditor', () => ({
  useMonacoEditor: () => stableController,
}))

import { MonacoEditor } from './MonacoEditor'

async function renderOpened(): Promise<void> {
  render(<MonacoEditor projectPath="/proj" />)
  // Wait for the entry-file auto-open so root/refs are set and the
  // editor:openFile subscription is live.
  await waitFor(() => {
    expect(capturedOpenHandler).toBeTypeOf('function')
    expect(openModel).toHaveBeenCalled()
  })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  readProjectFile.mockClear()
  listProjectFiles.mockClear()
  openModel.mockClear()
  revealPosition.mockClear()
  capturedOpenHandler = undefined
})

afterEach(() => {
  vi.clearAllTimers()
})

describe('MonacoEditor — open-in-editor from a console file link', () => {
  it('opens the requested file and reveals the line/column', async () => {
    await renderOpened()
    openModel.mockClear()
    revealPosition.mockClear()

    await act(async () => {
      capturedOpenHandler!({ path: 'pages/home/home.js', line: 12, column: 5 })
      await Promise.resolve()
    })

    await waitFor(() => {
      // Opened by the project-relative key joined to the root.
      expect(openModel).toHaveBeenCalledWith(
        '/proj/pages/home/home.js',
        'content-of:/proj/pages/home/home.js',
        'javascript',
      )
      // Jumped to the requested position.
      expect(revealPosition).toHaveBeenCalledWith(12, 5)
    })
  })

  it('opens without revealing when no line is given', async () => {
    await renderOpened()
    openModel.mockClear()
    revealPosition.mockClear()

    await act(async () => {
      capturedOpenHandler!({ path: 'pages/home/home.js' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(openModel).toHaveBeenCalledWith(
        '/proj/pages/home/home.js',
        expect.any(String),
        'javascript',
      )
    })
    expect(revealPosition).not.toHaveBeenCalled()
  })

  it('ignores an empty/invalid open request', async () => {
    await renderOpened()
    openModel.mockClear()
    revealPosition.mockClear()

    await act(async () => {
      capturedOpenHandler!({ path: '' })
      await Promise.resolve()
    })

    expect(openModel).not.toHaveBeenCalled()
    expect(revealPosition).not.toHaveBeenCalled()
  })
})
