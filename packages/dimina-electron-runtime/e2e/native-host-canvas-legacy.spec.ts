/**
 * Native-host coverage for the legacy `wx.createCanvasContext` pipeline. The
 * fixture records actions in the logic layer, replays them on a real DOM
 * canvas and verifies pixels and browser-owned state in the render guest.
 * This guards reserve semantics, gradients, fonts, clipping and draw ordering
 * that call-sequence unit tests cannot prove.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
  getPageData,
  RENDER_GUEST_URL_MARKER,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'canvas-app')
const APP_ID = 'devtools_canvas_fixture' // fixtures/canvas-app/project.config.json appid

let electronApp: ElectronApplication
let mainWindow: PwPage

type RGBA = [number, number, number, number]

/** Tap a fixture button (matched by its `data-action` attribute) inside the
 * active render-host guest document — the same DOM the real page renders,
 * so this fires the WXML `bindtap` handler exactly as a real tap would. */
async function clickAction(action: string): Promise<boolean> {
  return evalInWebContentsByUrl<boolean>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const el = document.querySelector('[data-action="${action}"]')
      if (el && typeof el.click === 'function') { el.click(); return true }
      return false
    })()`,
  )
}

/** Read back a single pixel from the REAL render-side canvas — the only way
 * to prove the recorded actions actually painted the right thing. */
async function readCanvasPixel(x: number, y: number): Promise<RGBA> {
  return evalInWebContentsByUrl<RGBA>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const canvas = document.querySelector('canvas[canvas-id="mainCanvas"]')
      if (!canvas) throw new Error('mainCanvas not found in render-host guest')
      const data = canvas.getContext('2d').getImageData(${x}, ${y}, 1, 1).data
      return [data[0], data[1], data[2], data[3]]
    })()`,
  )
}

/** Read back the REAL render-side `CanvasRenderingContext2D.font` string —
 * the browser's own serialization, not the logic layer's recorded state. */
async function readCanvasFont(): Promise<string> {
  return evalInWebContentsByUrl<string>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const canvas = document.querySelector('canvas[canvas-id="mainCanvas"]')
      if (!canvas) throw new Error('mainCanvas not found in render-host guest')
      return canvas.getContext('2d').font
    })()`,
  )
}

async function waitForFlag(flag: string): Promise<void> {
  await pollUntil(
    () => getPageData(electronApp, APP_ID, flag).catch(() => undefined),
    (v) => v === true,
    20000,
    300,
  )
}

test.describe('native-host legacy CanvasContext e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-canvas-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)

    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )

    // The canvas itself must be present in the render-host guest before any
    // test taps a button that targets it.
    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        electronApp,
        RENDER_GUEST_URL_MARKER,
        `(() => !!document.querySelector('canvas[canvas-id="mainCanvas"]'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('fillRect paints the real canvas at the recorded coordinates', async () => {
    expect(await clickAction('basic-rect')).toBe(true)
    await waitForFlag('basicRectDone')

    // Inside the filled rect (20,20)-(80,80): solid opaque red.
    const inside = await readCanvasPixel(50, 50)
    expect(inside, `pixel inside the filled rect should be red, got ${JSON.stringify(inside)}`).toEqual([255, 0, 0, 255])

    // Outside the rect: canvas background, i.e. NOT red.
    const outside = await readCanvasPixel(150, 150)
    expect(outside[0], `pixel outside the filled rect should not be red, got ${JSON.stringify(outside)}`).not.toBe(255)
  })

  test('draw(reserve) resets render state on false and preserves it on true', async () => {
    // Phase A: translated blue square, real canvas coords (50,50)-(90,90).
    expect(await clickAction('reserve-batch-a')).toBe(true)
    await waitForFlag('reserveBatchADone')
    const afterA = await readCanvasPixel(70, 70)
    expect(afterA, `phase A should paint blue at (70,70), got ${JSON.stringify(afterA)}`).toEqual([0, 0, 255, 255])

    // Phase B: draw(false) with NO fillStyle/translate recorded by this
    // handler. A leaked blue fillStyle or leaked translate(50,50) would be a
    // render-layer bug — this handler cannot cause either itself.
    expect(await clickAction('reserve-batch-b-reset')).toBe(true)
    await waitForFlag('reserveBatchBDone')

    // Phase A's blue square must be gone (draw(false) clears the whole canvas).
    const clearedSpot = await readCanvasPixel(70, 70)
    expect(clearedSpot[2], `draw(false) must clear phase A's blue square, got ${JSON.stringify(clearedSpot)}`).not.toBe(255)

    // Phase B's own rect lands at (0,0)-(40,40) using the RESET default
    // fillStyle (black) and RESET transform (no translate carried over).
    const resetSpot = await readCanvasPixel(20, 20)
    expect(resetSpot, `phase B should paint black at (20,20) with reset state, got ${JSON.stringify(resetSpot)}`).toEqual([0, 0, 0, 255])

    // Phase C: draw(true) must NOT clear phase B's square, only add to it.
    expect(await clickAction('reserve-batch-c-keep')).toBe(true)
    await waitForFlag('reserveBatchCDone')

    const preserved = await readCanvasPixel(20, 20)
    expect(preserved, `draw(true) must preserve phase B's black square, got ${JSON.stringify(preserved)}`).toEqual([0, 0, 0, 255])

    const added = await readCanvasPixel(120, 120)
    expect(added, `phase C should add a green square at (120,120), got ${JSON.stringify(added)}`).toEqual([0, 170, 0, 255])
  })

  test('linear gradient reconstructs on the real canvas with the correct color at each end', async () => {
    expect(await clickAction('gradient')).toBe(true)
    await waitForFlag('gradientDone')

    // Gradient runs red (x=0) -> blue (x=200) across the full canvas width.
    // Near the left edge red should clearly dominate blue; near the right
    // edge the reverse. Exact interpolated values depend on the browser's
    // color-space handling, so this checks channel DOMINANCE, not exact RGB.
    const left = await readCanvasPixel(4, 100)
    const right = await readCanvasPixel(196, 100)
    expect(left[0], `left edge should be red-dominant, got ${JSON.stringify(left)}`).toBeGreaterThan(left[2])
    expect(right[2], `right edge should be blue-dominant, got ${JSON.stringify(right)}`).toBeGreaterThan(right[0])
  })

  test('measureText width scales with a larger font size', async () => {
    expect(await clickAction('measure-fonts')).toBe(true)
    await pollUntil(
      () => getPageData(electronApp, APP_ID, 'measureBigWidth').catch(() => undefined),
      (v) => typeof v === 'number',
      20000,
      300,
    )

    const smallWidth = await getPageData(electronApp, APP_ID, 'measureSmallWidth') as number
    const bigWidth = await getPageData(electronApp, APP_ID, 'measureBigWidth') as number

    expect(typeof smallWidth, 'measureText should return a numeric width').toBe('number')
    expect(smallWidth, 'measured width should be positive').toBeGreaterThan(0)
    // 48px vs 16px (3x) for the same string — the width must grow
    // substantially, not just by rounding noise.
    expect(bigWidth, `48px text (${bigWidth}) should measure noticeably wider than 16px text (${smallWidth})`).toBeGreaterThan(smallWidth * 1.5)
  })

  test('a font whose modifier tokens are reassembled in input order (weight before style) is accepted by the real canvas', async () => {
    // 'bold italic 18px Georgia' — official reassembly keeps input order, so
    // weight ('bold') precedes style ('italic'). If a real canvas silently
    // rejected this shape, ctx.font would keep whatever it was before and
    // never pick up '18px'/'Georgia' — a failure mode unit tests (which use
    // an all-accepting fake context) cannot see.
    expect(await clickAction('font-accept-weight-style')).toBe(true)
    await waitForFlag('fontAcceptWeightStyleDone')
    const fontA = await readCanvasFont()
    expect(fontA, `real canvas should accept the weight-before-style font, got "${fontA}"`).toContain('18px')
    expect(fontA.toLowerCase(), `real canvas should accept the weight-before-style font, got "${fontA}"`).toContain('georgia')

    // 'bold 16px serif' — a single input modifier token gets a trailing
    // 'normal' appended ('bold normal 16px serif'), still weight-first.
    // Checked as a whole-token match (not just "contains serif") because
    // 'sans-serif' would also satisfy a bare substring check.
    expect(await clickAction('font-accept-single-modifier')).toBe(true)
    await waitForFlag('fontAcceptSingleModifierDone')
    const fontB = await readCanvasFont()
    expect(fontB, `real canvas should accept the single-modifier font, got "${fontB}"`).toContain('16px')
    expect(/(?:^|\s)serif$/i.test(fontB), `real canvas should land on the 'serif' family (not e.g. leftover 'sans-serif'), got "${fontB}"`).toBe(true)
  })

  test('two draw() batches on the same canvas serialize: a later sync batch wins over an earlier batch still decoding an image', async () => {
    // Both draw() calls fire in the same synchronous tick. Batch 1 draws a
    // full-canvas image (a genuine async decode). Batch 2 is pure
    // synchronous fillRect with no image. Correct per-canvas serialization
    // means batch 2 waits for batch 1 to fully finish before it even starts
    // its own reserve:false reset+replay — so the LATER submitted batch (2)
    // is what the final canvas shows. Without serialization, batch 2 would
    // race ahead (nothing async to await) and finish first, only to be wiped
    // out when batch 1 resumes later and clears the canvas again for its own
    // replay — ending on batch 1's image instead of batch 2's rect.
    expect(await clickAction('serial-draw')).toBe(true)
    await waitForFlag('serialBatch1Done')
    await waitForFlag('serialBatch2Done')

    const finalPixel = await readCanvasPixel(100, 100)
    expect(finalPixel, `the later batch (green fillRect) should win the final canvas state, got ${JSON.stringify(finalPixel)}`).toEqual([0, 170, 0, 255])
  })

  test('fill snapshots the current path and rebuilds it under the transform active at each fill', async () => {
    expect(await clickAction('path-snapshot-transform')).toBe(true)
    await waitForFlag('pathSnapshotTransformDone')

    expect(await readCanvasPixel(10, 10)).toEqual([0, 0, 0, 255])
    expect(await readCanvasPixel(70, 10)).toEqual([0, 170, 0, 255])
  })

  test('save() snapshots a copy of the drawing state so restore() actually undoes translate/fillStyle', async () => {
    expect(await clickAction('save-restore')).toBe(true)
    await waitForFlag('saveRestoreDone')

    // Second fillRect, issued after restore(), must land back at the
    // untranslated origin with the pre-save default fillStyle (black) — not
    // still purple/translated, which is what a save() that pushes a shared
    // state REFERENCE (rather than a copy) would produce.
    const origin = await readCanvasPixel(10, 10)
    expect(origin, `post-restore fillRect should be black at the untranslated origin, got ${JSON.stringify(origin)}`).toEqual([0, 0, 0, 255])

    // The save()-scoped fillRect itself did land at its translated spot.
    const savedSpot = await readCanvasPixel(70, 70)
    expect(savedSpot, `the save()-scoped fillRect should have painted purple at (70,70), got ${JSON.stringify(savedSpot)}`).toEqual([128, 0, 128, 255])
  })

  test('canvas export defaults use the device pixel ratio and return a reusable temp path', async () => {
    const exportedPaths: string[] = []
    for (const attempt of [1, 2]) {
      expect(await clickAction('export-defaults')).toBe(true)
      await pollUntil(
        () => getPageData(electronApp, APP_ID).catch(() => undefined),
        (value) => {
          const data = value as Record<string, unknown> | undefined
          return data?.exportCompletedAttempt === attempt && data.exportCompleteAttempt === attempt
        },
        5000,
        200,
      )
      const pageData = await getPageData(electronApp, APP_ID) as Record<string, unknown>

      expect(pageData.exportError, `canvas export failed: ${JSON.stringify(pageData)}`).toBeFalsy()
      expect(pageData.exportCompleteErrMsg).toBe('canvasToTempFilePath:ok')
      expect(pageData.exportTempFilePath).toMatch(/^difile:\/\/_tmp\//)
      expect(typeof pageData.exportBytesBase64, `export page data: ${JSON.stringify(pageData)}`).toBe('string')
      const png = Buffer.from(pageData.exportBytesBase64 as string, 'base64')
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBe(50 * Number(pageData.exportPixelRatio))
      expect(png.readUInt32BE(20)).toBe(25 * Number(pageData.exportPixelRatio))
      exportedPaths.push(pageData.exportTempFilePath as string)
    }
    expect(new Set(exportedPaths).size).toBe(2)
  })

  test('pixel API callbacks cross the real service/render bridge as result objects', async () => {
    expect(await clickAction('pixel-round-trip')).toBe(true)
    await waitForFlag('pixelRoundTripStarted')
    await waitForFlag('pixelRoundTripDone')
    const pageData = await getPageData(electronApp, APP_ID) as Record<string, unknown>

    expect(pageData.pixelRoundTripError, `pixel API failed: ${JSON.stringify(pageData)}`).toBeUndefined()
    expect(pageData.pixelPutErrMsg, `pixel callback did not complete: ${JSON.stringify(pageData)}`).toBe('canvasPutImageData:ok')
    expect(pageData.pixelGetErrMsg).toBe('canvasGetImageData:ok')
    expect(pageData.pixelBytes).toEqual([9, 18, 27, 255])
    expect(pageData.pixelDataType).toBe('[object Uint8ClampedArray]')
  })

  test('a clip region from an earlier batch does not survive into a later reserve:false batch that never calls clip itself', async () => {
    // Phase A: clip to the top-left 50x50, then fill the whole canvas — only
    // the clipped region should actually take the fill color.
    expect(await clickAction('clip-lock-batch-a')).toBe(true)
    await waitForFlag('clipLockBatchADone')

    const insideClip = await readCanvasPixel(25, 25)
    expect(insideClip, `pixel inside the clip region should be orange, got ${JSON.stringify(insideClip)}`).toEqual([255, 136, 0, 255])
    const outsideClipBeforeFix = await readCanvasPixel(150, 150)
    expect(outsideClipBeforeFix, `pixel outside the clip region should NOT have taken phase A's fill, got ${JSON.stringify(outsideClipBeforeFix)}`).not.toEqual([255, 136, 0, 255])

    // Phase B: a fresh CanvasContext that never calls clip() itself. A
    // reserve:false draw() must fully reset the render-side clip region —
    // this fill must reach the WHOLE canvas, including the bottom-right
    // corner that phase A's clip region never covered. If the clip region
    // survives (the bug), this fill stays locked to phase A's leftover
    // top-left 50x50 clip and (150,150) is never reachable again.
    expect(await clickAction('clip-lock-batch-b-no-clip')).toBe(true)
    await waitForFlag('clipLockBatchBDone')

    const bottomRight = await readCanvasPixel(150, 150)
    expect(bottomRight, `draw(false) must clear the stale clip region so phase B can paint (150,150), got ${JSON.stringify(bottomRight)}`).toEqual([0, 136, 255, 255])
    const topLeft = await readCanvasPixel(25, 25)
    expect(topLeft, `phase B should also repaint the former clip region itself, got ${JSON.stringify(topLeft)}`).toEqual([0, 136, 255, 255])
  })

  test('an unbalanced restore() in one batch does not corrupt canvas state for the next batch', async () => {
    // Phase A: one more restore() than save() in this same batch. A real
    // canvas silently no-ops restore() once its state stack is empty, but if
    // the render layer leans on its OWN save/restore pairing to reset
    // per-batch state, an unbalanced restore from user code must not be able
    // to pop past that guard and corrupt the next batch.
    expect(await clickAction('unbalanced-restore-batch-a')).toBe(true)
    await waitForFlag('unbalancedRestoreADone')

    const phaseASpot = await readCanvasPixel(50, 50)
    expect(phaseASpot, `phase A's own fill should still land correctly at (50,50), got ${JSON.stringify(phaseASpot)}`).toEqual([255, 136, 0, 255])

    // Phase B: a plain, unrelated fill with no save/restore of its own — must
    // render normally (untranslated, unclipped) regardless of phase A's
    // imbalance.
    expect(await clickAction('unbalanced-restore-batch-b-clean')).toBe(true)
    await waitForFlag('unbalancedRestoreBDone')

    const phaseBSpot = await readCanvasPixel(15, 15)
    expect(phaseBSpot, `phase B should paint cleanly at (15,15), unaffected by phase A's unbalanced restore, got ${JSON.stringify(phaseBSpot)}`).toEqual([0, 136, 255, 255])
  })
})
