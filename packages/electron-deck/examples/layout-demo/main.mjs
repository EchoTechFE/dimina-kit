// electron-deck layout demo — REAL user-side API, end-to-end, offscreen.
//
// This drives the ACTUAL framework entry `startElectronDeck(config, { backend })`
// (synchronous `{ ready, dispose }` handle — no deadlock glue) and the REAL
// `runtime.view({ source, scope }).placeIn(win, { anchor })` slot-token path. The
// renderer (control.html) runs the REAL `createDeckLayoutClient({ bridge })` with
// the turnkey `window.__electronDeckLayoutBridge` from `exposeDeckLayoutBridge()`.
//
// What it proves:
//   • A project list → click → devtools-like split layout (left #simulator,
//     right #devtools) with a draggable splitter.
//   • Native color blocks FOLLOW their DOM slots via the real slot-token
//     mechanism (host issues SlotGrant on `placeIn({anchor})`; renderer's
//     view-anchor measures + sends Place; host moves the WebContentsView).
//   • A programmatic splitter drag moves the native blocks — renderer-driven
//     geometry, ZERO host resize code.
//
// Run offscreen:  electron examples/layout-demo/main.mjs
// Windows are created hidden + showInactive() at x:-3000 so they paint (native
// child views composite) WITHOUT ever appearing or stealing focus. Each step
// writes a composite PNG (host page + native blocks blitted in z-order) to
// shots/*.png — capturePage() alone omits child WebContentsViews.

import { app, ipcMain } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'

// The REAL framework entry, imported from the built dist (the example lives
// inside the package and the package is not symlinked for self-import).
// `startElectronDeck` returns `{ ready, dispose }` SYNCHRONOUSLY — safe to use
// from an ESM main entry with no deadlock-workaround glue.
import { startElectronDeck } from '../../dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
const BLOCK = pathToFileURL(join(HERE, 'block.html')).href
const CONTROL = pathToFileURL(join(HERE, 'control.html')).href
const PRELOAD = join(HERE, 'demo-preload.mjs')

const Z = { SIMULATOR: 0, DEVTOOLS: 10 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Unbuffered trace: Electron's main-process stdout is block-buffered when piped
// to a file and only flushes on exit; a hung run would show an empty log. Write
// each line synchronously so the trace survives a hang.
const TRACE = join(HERE, 'shots', 'trace.log')
const log = (...a) => {
  const line = '[demo] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  try { appendFileSync(TRACE, line + '\n') } catch {}
}

// ── composite-screenshot machinery (host page + native blocks in z-order) ────
let compositeReq = 0
const compositeWaiters = new Map()
ipcMain.on('demo:composite-result', (_e, reqId, dataUrl) => {
  const res = compositeWaiters.get(reqId)
  if (res) { compositeWaiters.delete(reqId); res(dataUrl) }
})

// Track the native views we placed so the compositor snapshot can blit them in
// z-order at their CURRENT bounds. The framework's DeckViewHandle does NOT
// expose the underlying WebContentsView, so we hold our own ref to each native
// view (see DEMO GLUE in assemble()).
const placedBlocks = [] // { wcv, label, zone }

async function shot(win, name) {
  const hostImg = await win.webContents.capturePage()
  // z-order = ascending zone (matches the compositor's (zone, …) total order).
  const ordered = [...placedBlocks].sort((a, b) => a.zone - b.zone)
  const blocks = []
  for (const blk of ordered) {
    if (blk.wcv.webContents.isDestroyed()) continue
    const b = blk.wcv.getBounds()
    if (b.width === 0 || b.height === 0) continue // hidden placement
    const png = (await blk.wcv.webContents.capturePage()).toDataURL()
    blocks.push({ png, x: b.x, y: b.y, width: b.width, height: b.height, label: blk.label })
  }
  const reqId = ++compositeReq
  const done = new Promise((res) => compositeWaiters.set(reqId, res))
  win.webContents.send('demo:composite', reqId, hostImg.toDataURL(), blocks)
  const dataUrl = await done
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  await writeFile(join(SHOTS, name), buf)
  log('shot →', name, `(${blocks.length} native blocks:`, blocks.map((b) => `${b.label}@${b.x},${b.width}w`).join(' < ') + ')')
}

mkdirSync(SHOTS, { recursive: true })
log('boot: about to call startElectronDeck()')

// ─────────────────────────────────────────────────────────────────────────────
// HOST: the REAL `startElectronDeck(config, { backend })`. The framework owns process
// lifecycle / window construction / trust / wire; the backend supplies domain
// assembly. We do NOT set ownsWindows — the framework builds + auto-trusts the
// main window, and we just load our control renderer into it.
// ─────────────────────────────────────────────────────────────────────────────

let resolveDone
const allDone = new Promise((r) => { resolveDone = r })

// `startElectronDeck()` returns `{ ready, dispose }` SYNCHRONOUSLY — no internal
// whenReady gate sits on top-level await, so the old deadlock-workaround glue is
// GONE. Assembly still runs strictly after app.whenReady() (gating intact inside
// start()); we just `void`-fire it and let the offscreen driver resolve `allDone`.
const { ready } = startElectronDeck(
  {
    app: {
      // show:false → framework builds the window hidden; we showInactive()
      // offscreen after load so native child views composite into capturePage.
      window: { width: 900, height: 520, show: false, backgroundColor: '#1e1e2e' },
    },
  },
  {
    backend: {
      // The ESM preload (demo-preload.mjs) imports exposeDeckLayoutBridge() from
      // the framework's preload dist, so it requires `sandbox:false` (Electron's
      // ESM-preload requirement). This webPreferences hook is the seam for the
      // framework-built main window's preload.
      mainWindowWebPreferences() {
        return {
          preload: PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        }
      },

      async assemble(runtime) {
        log('assemble: entered')
        const mainWin = runtime.mainWindow
        log('assemble: mainWindow =', String(!!mainWin))

        // RESIDUAL GLUE (#2 — not addressed by P0–P5): the framework still loads
        // NO content into the main window it built, and there is no
        // `config.app.source` declarative main-renderer entry (unlike the toolbar
        // / declared windows, which DO take a `source`). So the host still drives
        // loadURL by hand here. Tracked as future ergonomics; not part of P0–P5.
        // Surface renderer errors into our trace (diagnostics).
        mainWin.webContents.on('preload-error', (_e, path, err) => {
          log('[preload-error]', path, String(err))
        })
        log('assemble: loadURL start')
        await mainWin.webContents.loadURL(CONTROL)
        log('assemble: loadURL done')

        // showInactive() offscreen → forces a real paint so child
        // WebContentsViews composite, WITHOUT focus/visibility (verification).
        mainWin.setPosition(-3000, -3000)
        mainWin.showInactive()

        // ── open-project: spawn two native color blocks following the slots ──
        let projectViews = []
        ipcMain.on('demo:open-project', (e, projectId) => {
          // ignore re-opens of the same project session for simplicity
          if (projectViews.length) return
          log('open-project:', projectId)

          // REAL API: a per-project SESSION via runtime.scopes.create(). Binding
          // each view to this DeckSession gives the project a single teardown
          // handle — session.dispose() detaches + closes every view bound to it
          // (and app shutdown cascades in too). No raw/internal Scope handling.
          const session = runtime.scopes.create()

          // RESIDUAL GLUE (#6 — not addressed by P0–P5): `DeckViewHandle` still
          // exposes no `webContents` / `bounds()` / `capture()`. Our OFFSCREEN
          // composite snapshot needs each native view's live bounds + a
          // capturePage(), so we recover the WCV by diffing
          // mainWin.contentView.children around each placeIn. A host that doesn't
          // screenshot/inspect native views never needs this.
          const captureNewWcv = (handle, source, label, zone) => {
            const before = new Set(mainWin.contentView.children)
            // REAL API: runtime.view({ source, scope }).placeIn(win, { zone, anchor }).
            // The `anchor` mints a slot token + PUSHES a SlotGrant to the control
            // wc; the renderer's createDeckLayoutClient picks it up and measures
            // that DOM slot, threading Placements back here. The framework moves
            // the WebContentsView to follow — we write NO resize code; geometry
            // is 100% renderer-driven.
            handle.placeIn(mainWin, { zone, anchor: source })
            const added = mainWin.contentView.children.find((c) => !before.has(c))
            if (added) placedBlocks.push({ wcv: added, label, zone })
            return handle
          }
          const sim = captureNewWcv(
            runtime.view({ source: { url: `${BLOCK}#${enc('#c0392b', 'SIMULATOR')}` }, scope: session }),
            '#simulator', 'SIMULATOR', Z.SIMULATOR,
          )
          const dev = captureNewWcv(
            runtime.view({ source: { url: `${BLOCK}#${enc('#2980b9', 'DEVTOOLS')}` }, scope: session }),
            '#devtools', 'DEVTOOLS', Z.DEVTOOLS,
          )
          projectViews = [sim, dev]
          log('placed native views; contentView.children =', String(mainWin.contentView.children.length), '; placedBlocks =', String(placedBlocks.length))

          // ── privileged layout command + grant (now FULLY user-side) ──
          // A host that wants the renderer to invoke a PRIVILEGED `layout.*` op
          // registers it via runtime.layout.command(...) and authorizes the
          // control wc via runtime.grants.issue(...). `targetScope` is now an
          // ergonomic, user-side DeckSession (the one we just minted) — no
          // internal Scope handle required. The renderer doesn't drive it in the
          // happy path (the splitter is pure DOM→Place), but it now stands up
          // end-to-end with ZERO glue.
          try {
            runtime.layout.command('layout.collapse-sim', () => {
              // host-side collapse: hide the simulator view
              projectViews[0].applyPlacement({ visible: false })
              return 'ok'
            })
            runtime.grants.issue(e.sender, {
              commands: ['layout.collapse-sim'],
              targetScope: session,
            })
            log('registered layout.collapse-sim + issued grant (targetScope = user-side DeckSession)')
          } catch (err) {
            log('layout.command/grant failed:', String(err))
          }
        })

        // ── verification driver (offscreen) ──
        void runVerification(mainWin).then(resolveDone).catch((err) => {
          console.error('[demo] verification failed:', err)
          resolveDone()
        })
      },
    },
  },
)

// startElectronDeck never deadlocks on top-level await, but a startup FAILURE
// still surfaces on `ready`. Observe it so a broken boot quits instead of hanging.
ready.catch((err) => {
  console.error('[demo] startElectronDeck failed:', err)
  log('startElectronDeck failed: ' + String(err))
  app.quit()
})

function enc(color, label) {
  return encodeURIComponent(`${color}|${label}`)
}

// ── offscreen verification: 3 screenshots proving the native blocks follow ───
async function runVerification(mainWin) {
  await sleep(500)
  // (a) project list
  await shot(mainWin, '1-project-list.png')

  // (b) open a project → detail layout; both blocks visible, following slots.
  // Click the first project card from the host side via executeJavaScript.
  await mainWin.webContents.executeJavaScript(`document.querySelector('.card').click()`)
  // Set a deterministic initial split (sim = 360px) so the "before" geometry is
  // stable, then wait for: openProject ipc → host placeIn → SlotGrant push →
  // renderer anchor measure → Place → host moves WCV.
  await sleep(400)
  await mainWin.webContents.executeJavaScript(`window.__demoSetSplit(360)`)
  await sleep(700)
  await shot(mainWin, '2-detail-following.png')
  const before = await captureSimBounds()
  log('STEP2: native sim/dev bounds at split=360 :', JSON.stringify(before))

  // (c) programmatic splitter drag → DOM split changes → view-anchor
  // re-measures → Place → native blocks MOVE. Prove they followed by commanding
  // a NARROWER simulator (220px) and checking the native sim shrank toward it
  // and the native devtools shifted left to fill.
  await mainWin.webContents.executeJavaScript(`window.__demoSetSplit(220)`)
  await sleep(700)
  await shot(mainWin, '3-after-drag.png')
  const after = await captureSimBounds()
  log('STEP3: native sim/dev bounds at split=220 :', JSON.stringify(after))

  // PROOF: the native simulator block's width must TRACK the commanded split
  // (360 → 220, a ~140px shrink, allowing for the slot's 8px CSS margins) and
  // the native devtools block's x must move LEFT by a similar amount. Geometry
  // is renderer-driven (the host wrote no bounds): if these hold, slot-token
  // following covers live renderer resize.
  const simDelta = before.sim && after.sim ? before.sim.width - after.sim.width : 0
  const devDelta = before.sim && after.sim ? before.dev.x - after.dev.x : 0
  const simTracked = simDelta > 100 && simDelta < 180   // ~140 expected
  const devFollowed = devDelta > 100 && devDelta < 180  // devtools.x shifts left ~140
  log('PROOF: simWidthΔ =', String(simDelta), '(expect ~140) | devXΔ(left) =', String(devDelta), '(expect ~140)')
  if (simTracked && devFollowed) log('✅ split-drag MOVED the native color blocks (renderer-driven geometry, zero host resize code).')
  else log('❌ native blocks did NOT track the split — slot-token did not cover renderer-driven resize.')

  log('ALL STEPS DONE')
}

function captureSimBounds() {
  const out = {}
  for (const blk of placedBlocks) {
    if (blk.wcv.webContents.isDestroyed()) continue
    const b = blk.wcv.getBounds()
    out[blk.label === 'SIMULATOR' ? 'sim' : 'dev'] = { x: b.x, width: b.width }
  }
  return Promise.resolve(out)
}

void allDone.then(async () => {
  await sleep(200)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
process.on('uncaughtException', (e) => { console.error('[demo] UNCAUGHT', e); app.quit() })
