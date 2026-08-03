/**
 * E2E: `wx.getFileSystemManager()` async methods must round-trip through the
 * REAL service-thread <-> container bridge (postMessage `invokeAPI` ->
 * container `simulatorApis['FileSystemManager.<name>']` handler), and
 * `saveImageToPhotosAlbum` must reject a non-local filePath (dataURL / http)
 * the way a real device does.
 *
 * Today `wx.getFileSystemManager().writeFile(...)` always calls `fail` with
 * an errMsg containing "not supported by the dimina runtime" (see
 * `packages/devtools/src/simulator/service-apis/file/index.js`), and
 * `saveImageToPhotosAlbum` accepts any filePath unconditionally (see
 * `packages/devtools/src/simulator/simulator-api-media.ts`). This spec drives
 * the fixture app's real onLoad self-test (not a synthetic direct call from
 * the simulator top document) so it exercises the exact path a real
 * mini-program hits.
 *
 * The fixture (`fixtures/fsm-app`) runs the sequence in `pages/index/index.js`
 * onLoad and `setData()`s a JSON summary into a `.fsm-result` text node; this
 * spec reads that node back via `evalInSimulator` and asserts on the parsed
 * summary — a structural result, not stdout/console text.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import { openProject, pollUntil, RENDER_GUEST_URL_MARKER } from './helpers'
import type { ElectronApplication } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'fsm-app')

interface FsmSummary {
  write1Ok?: boolean
  write1ErrMsg?: string
  read1Ok?: boolean
  read1Data?: string | null
  write2Ok?: boolean
  read2Ok?: boolean
  read2IsArrayBuffer?: boolean
  read2BytesMatch?: boolean
  writeFileSyncThrew?: boolean
  canIUseChecked?: boolean
  canIUseWriteFile?: boolean
  canIUseWriteFileSync?: boolean
  saveImageOk?: boolean
  saveImageErrMsg?: string
  saveFlowWriteOk?: boolean
  savedFileOk?: boolean
  savedFilePath?: string | null
  savedFilePathIsStore?: boolean
  savedListContainsBeforeRemove?: boolean
  removeSavedFileOk?: boolean
  savedListContainsAfterRemove?: boolean
  savedToTargetOk?: boolean
  savedToTargetPath?: string | null
  readTargetOk?: boolean
  readTargetData?: string | null
  uncaughtError?: string
}

/**
 * The page's rendered DOM lives in a render-host webContents (each page frame
 * is a `dmb-resource://.../__frame__.html` document), not in the simulator
 * shell document — query every live page frame and return the first
 * non-empty `.fsm-result` text.
 */
async function readSummary(electronApp: ElectronApplication): Promise<FsmSummary | null> {
  const text = await electronApp
    .evaluate(async ({ webContents }, marker) => {
      const frames = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes(marker))
      for (const wc of frames) {
        if (wc.isLoading()) continue
        const value = (await wc.executeJavaScript(
          `(() => { const el = document.querySelector('.fsm-result'); return el ? (el.textContent || '') : '' })()`,
        )) as string
        if (value) return value
      }
      return ''
    }, RENDER_GUEST_URL_MARKER)
    .catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as FsmSummary
  } catch {
    return null
  }
}

test.describe('wx.getFileSystemManager() async parity + saveImageToPhotosAlbum path validation (e2e)', () => {
  test('real service<->container round trip: async FSM works, sync FSM throws, invalid save-image path fails without downloading', async ({ electronApp }) => {
    await openProject(electronApp, FIXTURE_DIR)

    const summary = await pollUntil(
      () => readSummary(electronApp),
      // readTargetOk is set by the LAST step of the fixture's onLoad chain —
      // waiting on it (not the earlier saveImageErrMsg) avoids reading a
      // partially-populated summary from a still-running chain.
      (s) => s !== null && s.readTargetOk !== undefined,
      25000,
      300,
    )

    expect(summary, 'fixture self-test summary should have rendered into .fsm-result').not.toBeNull()
    expect(summary!.uncaughtError, 'fixture self-test sequence should not throw').toBeUndefined()

    // 1. writeFile of a utf8 string must succeed with the short wx errMsg.
    expect(summary!.write1Ok, `writeFile should succeed (errMsg: ${summary!.write1ErrMsg})`).toBe(true)
    expect(summary!.write1ErrMsg).toBe('writeFile:ok')

    // 2. readFile with encoding:'utf8' must read back the exact string written.
    expect(summary!.read1Ok).toBe(true)
    expect(summary!.read1Data).toBe('hello-fsm')

    // 3. writeFile/readFile without encoding must round-trip raw bytes via
    // the ArrayBuffer<->base64 sentinel wire protocol.
    expect(summary!.write2Ok).toBe(true)
    expect(summary!.read2Ok).toBe(true)
    expect(summary!.read2IsArrayBuffer, 'readFile without encoding should decode to a real ArrayBuffer').toBe(true)
    expect(summary!.read2BytesMatch, 'ArrayBuffer bytes should round-trip exactly').toBe(true)

    // 4. writeFileSync has no synchronous transport over the simulator's
    // postMessage worker bridge — it must throw loudly, not silently no-op.
    expect(summary!.writeFileSyncThrew, 'writeFileSync must throw (sync FSM is unsupported in the simulator)').toBe(true)

    // 5. canIUse should reflect exactly the supported async surface, when
    // wx.canIUse itself is available in this runtime.
    if (summary!.canIUseChecked) {
      expect(summary!.canIUseWriteFile, 'canIUse("FileSystemManager.writeFile") should be true').toBe(true)
      expect(summary!.canIUseWriteFileSync, 'canIUse("FileSystemManager.writeFileSync") should be false').toBe(false)
    }

    // 6. saveImageToPhotosAlbum must reject a dataURL filePath instead of
    // downloading it, matching real-device (Android/iOS/Harmony) behavior.
    expect(summary!.saveImageOk).toBe(false)
    expect(summary!.saveImageErrMsg).toContain('invalid file path')

    // 7. saveFile without an explicit filePath -> auto-minted difile://_store/
    // vpath -> shows up in getSavedFileList -> removeSavedFile -> disappears.
    expect(summary!.saveFlowWriteOk).toBe(true)
    expect(summary!.savedFileOk, 'saveFile should succeed').toBe(true)
    expect(
      summary!.savedFilePathIsStore,
      `saveFile without filePath should default to a difile://_store/ vpath, got ${summary!.savedFilePath}`,
    ).toBe(true)
    expect(summary!.savedListContainsBeforeRemove, 'getSavedFileList should include the freshly-saved file').toBe(true)
    expect(summary!.removeSavedFileOk).toBe(true)
    expect(
      summary!.savedListContainsAfterRemove,
      'getSavedFileList should no longer include the file after removeSavedFile',
    ).toBe(false)

    // 8. saveFile with an explicit filePath must save under EXACTLY that
    // path (not an auto-minted _store/ vpath), readable back byte-for-byte.
    expect(summary!.savedToTargetOk, 'saveFile with an explicit filePath should succeed').toBe(true)
    expect(
      summary!.savedToTargetPath,
      'saveFile with an explicit filePath should report that same path back as savedFilePath',
    ).toMatch(/\/journey\/saved\.txt$/)
    expect(summary!.readTargetOk, 'readFile of the explicit saveFile destination should succeed').toBe(true)
    expect(summary!.readTargetData).toBe('save-me')
  })
})
