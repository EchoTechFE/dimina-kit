/**
 * popout-spike harness — a REAL Electron main process that drives the
 * `@dimina-kit/electron-deck` host-view live-migration path end to end:
 *
 *   runtime.view(...)                       // one native WebContentsView
 *     .placeIn(mainWindow)                  // home: docked in the main window
 *   handle.moveTo(popoutWindow,{rehome})    // POP OUT to a standalone window
 *   handle.moveTo(mainWindow,{rehome})      // POP BACK into the main window
 *
 * The spike's claim is that the view's WebContents is NEVER reloaded across the
 * migrations. We prove it three independent ways, sampled at every step:
 *   1. webContents.id is stable (same native object).
 *   2. a per-LOAD page marker (window.__popoutMarker) is unchanged (no reload
 *      regenerated it).
 *   3. a live page-driven counter (window.__tick) keeps counting UP from where
 *      it was, instead of resetting to ~0 (a reload would zero it).
 *
 * Result is printed as a single line: `POPOUT_SPIKE_RESULT=<json>`, so a wrapper
 * script can parse pass/fail without screen-scraping. Windows are positioned far
 * offscreen and never focused (background-friendly).
 */
import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { startElectronDeck } from '@dimina-kit/electron-deck'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VIEW_HTML = join(__dirname, 'view.html')
const HOST_HTML = join(__dirname, 'host.html')
const SHOT_DIR = join(__dirname, 'shots')

// Optional screenshot evidence (pass --shots). Best-effort: a capture failure
// never fails the spike — the JS-marker + wc.id assertions are the real proof.
const WANT_SHOTS = process.argv.includes('--shots')
async function shoot(handle, name) {
  if (!WANT_SHOTS) return
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const img = await handle.capturePage()
    writeFileSync(join(SHOT_DIR, name + '.png'), img.toPNG())
  } catch {
    // ignore — screenshots are佐证 only
  }
}

const steps = []
let failed = false
function record(name, ok, detail) {
  steps.push({ name, ok, ...detail })
  if (!ok) failed = true
}

function finish() {
  const result = { ok: !failed, steps }
  // eslint-disable-next-line no-console
  console.log('POPOUT_SPIKE_RESULT=' + JSON.stringify(result))
  // Give stdout a tick to flush before exit.
  setTimeout(() => app.exit(failed ? 1 : 0), 50)
}

async function settle(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

// Pull the live page identity (marker + counter) out of the view's WebContents.
async function readViewState(wc) {
  return wc.executeJavaScript(
    '({ marker: window.__popoutMarker, tick: window.__tick })',
    true,
  )
}

async function run(runtime) {
  // The framework-built main window is the "docked home" for the view.
  const mainWindow = runtime.mainWindow
  mainWindow.setPosition(-4000, -4000)

  // A standalone window = the "popped-out" destination.
  const popout = runtime.windows.create({
    source: { file: HOST_HTML },
    width: 480,
    height: 360,
  })
  popout.window.setPosition(-4000, -2000)

  // ── Create the migratable view + dock it in the main window ────────────────
  const handle = runtime.view({ source: { file: VIEW_HTML } })
  const viewWc = handle.webContents
  const originalId = viewWc.id

  handle.placeIn(mainWindow, { zone: 0 })
  handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 480, height: 360 } })

  // Wait for the page to load + the live counter to advance past zero (the
  // setInterval fires every 50ms; 600ms guarantees several ticks even with
  // file-load latency, so the baseline `tick > 0` assertion is meaningful).
  await settle(600)
  const docked = await readViewState(viewWc)
  record('docked-in-main', viewWc.id === originalId && !!docked.marker && docked.tick > 0, {
    wcId: viewWc.id,
    marker: docked.marker,
    tick: docked.tick,
  })

  const homeMarker = docked.marker
  await shoot(handle, '1-docked-in-main')

  // ── POP OUT: live-migrate the view into the standalone window ──────────────
  await handle.moveTo(popout.window, { zone: 0, rehome: true })
  handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 480, height: 360 } })
  await settle(300)
  const poppedOut = await readViewState(viewWc)
  record(
    'popped-out',
    viewWc.id === originalId &&
      poppedOut.marker === homeMarker &&
      poppedOut.tick >= docked.tick,
    {
      wcId: viewWc.id,
      wcIdStable: viewWc.id === originalId,
      markerSurvived: poppedOut.marker === homeMarker,
      tickBefore: docked.tick,
      tickAfter: poppedOut.tick,
      tickAdvanced: poppedOut.tick >= docked.tick,
    },
  )
  await shoot(handle, '2-popped-out')

  // ── POP BACK: live-migrate the view back into the main window ──────────────
  await handle.moveTo(mainWindow, { zone: 0, rehome: true })
  handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 480, height: 360 } })
  await settle(300)
  const poppedBack = await readViewState(viewWc)
  record(
    'popped-back',
    viewWc.id === originalId &&
      poppedBack.marker === homeMarker &&
      poppedBack.tick >= poppedOut.tick,
    {
      wcId: viewWc.id,
      wcIdStable: viewWc.id === originalId,
      markerSurvived: poppedBack.marker === homeMarker,
      tickBefore: poppedOut.tick,
      tickAfter: poppedBack.tick,
      tickAdvanced: poppedBack.tick >= poppedOut.tick,
    },
  )
  await shoot(handle, '3-popped-back')

  // ── lifetime check: after rehome:true back to main, closing the POPOUT
  //    window must NOT tear the (now main-owned) view down. ───────────────────
  popout.window.close()
  await settle(200)
  let aliveAfterPopoutClose = false
  try {
    const after = await readViewState(viewWc)
    aliveAfterPopoutClose = after.marker === homeMarker && !viewWc.isDestroyed()
  } catch {
    aliveAfterPopoutClose = false
  }
  record('view-survives-popout-window-close', aliveAfterPopoutClose, {
    wcDestroyed: viewWc.isDestroyed(),
  })
}

const deck = startElectronDeck({
  app: { source: { file: HOST_HTML } },
})

deck.ready
  .then(async (runtime) => {
    try {
      await run(runtime)
    } catch (e) {
      record('harness-error', false, { error: String(e && e.stack ? e.stack : e) })
    } finally {
      finish()
    }
  })
  .catch((e) => {
    record('deck-start-failed', false, { error: String(e && e.stack ? e.stack : e) })
    finish()
  })
