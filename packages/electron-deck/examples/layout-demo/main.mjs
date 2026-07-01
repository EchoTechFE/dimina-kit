// electron-deck layout demo — REAL user-side API, end-to-end, offscreen.
//
// This drives the ACTUAL framework entry `startElectronDeck({ ...config, backend })`
// (synchronous `{ ready, dispose }` handle — no deadlock glue) and the REAL
// `runtime.view({ source, scope }).placeIn(win, { anchor })` slot-token path. The
// renderer (control.html) runs the REAL `createDeckLayoutClient({ bridge })` with
// the turnkey `window.__electronDeckLayoutBridge` from `exposeDeckLayoutBridge()`.
//
// Window facade: the demo is NOT ownsWindows, so the framework builds the main
// window and exposes it as a `DeckWindow` via `runtime.windows.main`. The demo
// uses that facade end-to-end instead of hand-wiring primitives:
//   • `main.window`      — the raw BrowserWindow (offscreen showInactive, paint
//                          wait, capturePage host).
//   • `main.newSession()`— mints a window-rooted DeckSession for the project
//                          (replaces runtime.scopes.create()).
//   • `main.controlWc`   — the main control-layer wc; grants are issued to it
//                          (replaces e.sender).
//   • `main.onClose(...)`— per-window close arbitration: closing with an active
//                          project RESETS the session and KEEPS the window;
//                          closing with no project closes it (window-lifetime >
//                          session-lifetime).
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

// Track the DeckViewHandles we placed so the compositor snapshot can blit each
// native view in z-order at its CURRENT bounds. The handle exposes
// `bounds()` / `capturePage()` / `webContents` directly — no contentView diffing.
const placedBlocks = [] // { handle, label, zone }

// Offscreen capturePage() of native WebContentsViews is finicky — the Viz
// compositor can transiently fail to produce a frame ("UnknownVizError") right
// after a layout change. Retry a few times with a short settle so the demo's
// screenshot proof is robust (this is a harness concern, not a framework one).
async function captureRetry(capturer, label, tries = 5) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try { return await capturer() }
    catch (e) { lastErr = e; await sleep(300) }
  }
  log(`capture failed after ${tries} tries (${label}): ${String(lastErr)}`)
  throw lastErr
}

async function shot(win, name) {
  const hostImg = await captureRetry(() => win.webContents.capturePage(), 'host')
  // z-order = ascending zone (matches the compositor's (zone, …) total order).
  const ordered = [...placedBlocks].sort((a, b) => a.zone - b.zone)
  const blocks = []
  for (const blk of ordered) {
    if (blk.handle.webContents.isDestroyed()) continue
    const b = blk.handle.bounds()
    if (!b || b.width === 0 || b.height === 0) continue // hidden / not placed
    const png = (await captureRetry(() => blk.handle.capturePage(), blk.label)).toDataURL()
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
// HOST: the REAL `startElectronDeck({ ...config, backend })`. The framework owns process
// lifecycle / window construction / trust / wire; the backend supplies domain
// assembly. We do NOT set ownsWindows — the framework builds + auto-trusts the
// main window and hands it back as a `DeckWindow` (runtime.windows.main); we
// drive everything (session, grant, close arbitration) through that facade.
// ─────────────────────────────────────────────────────────────────────────────

let resolveDone
let quitting = false   // set when the demo is intentionally tearing down (app.quit)
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
      // REAL API: declarative main-renderer entry. When the framework owns the
      // main window it auto-loads this source after build (mirrors the toolbar /
      // declared-window `source`). No hand-rolled loadURL in assemble() anymore.
      source: { url: CONTROL },
    },
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
        // Window facade: the framework built the main window (we are NOT
        // ownsWindows) and exposes it as a DeckWindow here. `main.window` is the
        // raw BrowserWindow (offscreen paint / capturePage); `main.newSession()`
        // mints window-rooted sessions; `main.controlWc` is the control-layer wc;
        // `main.onClose(...)` registers per-window close arbitration.
        const main = runtime.windows.main
        if (!main) {
          log('assemble: runtime.windows.main is null (unexpected for non-ownsWindows) — aborting')
          resolveDone()
          return
        }
        const mainWin = main.window
        log('assemble: windows.main =', String(!!main))

        // The framework auto-loads `config.app.source` ({ url: CONTROL }) into the
        // main window it built — assemble() no longer drives loadURL by hand.
        // Surface renderer errors into our trace (diagnostics).
        mainWin.webContents.on('preload-error', (_e, path, err) => {
          log('[preload-error]', path, String(err))
        })

        // The framework kicks off the source load just before assemble() runs, so
        // it may still be in flight here. Our offscreen showInactive() must follow
        // a real paint (so child WebContentsViews composite into capturePage), so
        // wait for did-finish-load rather than driving the load ourselves.
        if (!mainWin.webContents.isLoading()) {
          log('assemble: source already loaded')
        } else {
          log('assemble: awaiting source load')
          // Race finish vs fail so a failed navigation doesn't hang assemble forever.
          await new Promise((res) => {
            const done = (tag) => (...a) => { mainWin.webContents.off('did-finish-load', finish); mainWin.webContents.off('did-fail-load', fail); res(); if (tag === 'fail') log('[did-fail-load]', ...a.slice(1).map(String)) }
            const finish = done('finish')
            const fail = done('fail')
            mainWin.webContents.once('did-finish-load', finish)
            mainWin.webContents.once('did-fail-load', fail)
          })
          log('assemble: source load settled')
        }

        // showInactive() offscreen → forces a real paint so child
        // WebContentsViews composite, WITHOUT focus/visibility (verification).
        mainWin.setPosition(-3000, -3000)
        mainWin.showInactive()

        // ── open-project: spawn two native color blocks following the slots ──
        // `session` is hoisted so the per-window onClose decider (below) can see
        // whether a project is currently live: closing WITH a project resets the
        // session and keeps the window; closing with none lets the window close.
        let projectViews = []
        let session = null
        ipcMain.on('demo:open-project', (e, projectId) => {
          // ignore re-opens of the same project session for simplicity
          if (projectViews.length) return
          log('open-project:', projectId)

          // Window facade: a per-project SESSION via main.newSession() — a
          // WINDOW-ROOTED DeckSession (vs an app-root runtime.scopes.create()).
          // Binding each view to it gives the project a single teardown handle:
          // session.reset() detaches its views but keeps window+session alive
          // (used by onClose below); session.dispose() is the terminal close; and
          // because it is rooted in the window scope, closing the window cascades
          // it too. No raw/internal Scope handling.
          session = main.newSession()

          // REAL API: runtime.view({ source, scope }).placeIn(win, { zone, anchor }).
          // The `anchor` mints a slot token + PUSHES a SlotGrant to the control wc;
          // the renderer's createDeckLayoutClient picks it up and measures that DOM
          // slot, threading Placements back here. The framework moves the
          // WebContentsView to follow — we write NO resize code; geometry is 100%
          // renderer-driven. The returned DeckViewHandle exposes bounds() /
          // capturePage() / webContents, so the offscreen composite snapshot reads
          // them directly — no contentView.children diffing.
          const place = (color, label, zone, anchor) => {
            const handle = runtime
              .view({ source: { url: `${BLOCK}#${enc(color, label)}` }, scope: session })
              .placeIn(mainWin, { zone, anchor })
            placedBlocks.push({ handle, label, zone })
            return handle
          }
          const sim = place('#c0392b', 'SIMULATOR', Z.SIMULATOR, '#simulator')
          const dev = place('#2980b9', 'DEVTOOLS', Z.DEVTOOLS, '#devtools')
          projectViews = [sim, dev]
          log('placed native views; contentView.children =', String(mainWin.contentView.children.length), '; placedBlocks =', String(placedBlocks.length))

          // ── privileged layout command + grant (now FULLY user-side) ──
          // A host that wants the renderer to invoke a PRIVILEGED `layout.*` op
          // registers it via runtime.layout.command(...) and authorizes the
          // control wc via runtime.grants.issue(...). The grant target is
          // `main.controlWc` — the Window facade hands the control-layer wc back
          // directly (it is the same wc as the open-project sender `e.sender`, but
          // controlWc is the cleaner, facade-native expression). `targetScope` is
          // the window-rooted DeckSession we just minted — no internal Scope
          // handle required. The renderer doesn't drive it in the happy path (the
          // splitter is pure DOM→Place), but it stands up end-to-end with ZERO glue.
          try {
            runtime.layout.command('layout.collapse-sim', () => {
              // host-side collapse: hide the simulator view
              projectViews[0].applyPlacement({ visible: false })
              return 'ok'
            })
            runtime.grants.issue(main.controlWc, {
              commands: ['layout.collapse-sim'],
              targetScope: session,
            })
            log('registered layout.collapse-sim + issued grant (target = main.controlWc, scope = window-rooted DeckSession)')
          } catch (err) {
            log('layout.command/grant failed:', String(err))
          }
        })

        // ── close → reset demonstration (window-lifetime > session-lifetime) ──
        // The Window facade lets a host arbitrate its own window's close. Here:
        // if a project is live, closing RESETS the session (releases its views,
        // keeps the window) and returns 'keep'; if no project is live, returns
        // 'close' so the window actually closes. This is the canonical pattern —
        // the window outlives any single project session.
        main.onClose(async () => {
          // When the demo is intentionally tearing down (post-verification
          // app.quit), DON'T veto — let the window close so the process exits.
          if (quitting) return 'close'
          if (session) {
            log('onClose: active project → reset session, KEEP window')
            await session.reset()
            session = null
            projectViews = []
            return 'keep'
          }
          log('onClose: no active project → CLOSE window')
          return 'close'
        })

        // ── verification driver (offscreen) ──
        void runVerification(mainWin).then(resolveDone).catch((err) => {
          console.error('[demo] verification failed:', err)
          log('verification failed: ' + (err && err.stack ? err.stack : String(err)))
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

  // (d) renderer-driven HIDE → the reconciler must DETACH the native simulator
  // block (bounds() goes null) while devtools stays visible. Pure DOM display:none;
  // no host hide code.
  await mainWin.webContents.executeJavaScript(`window.__demoHideSim()`)
  await sleep(500)
  await shot(mainWin, '4-sim-hidden.png')
  const hidden = await captureSimBounds()
  const simDetached = !hidden.sim && !!hidden.dev
  log('STEP4: after hide, native bounds =', JSON.stringify(hidden))
  if (simDetached) log('✅ renderer-driven hide DETACHED the native simulator (level-triggered visible:false → reconcile detach).')
  else log('❌ simulator did NOT detach on hide — reconcile detach path broken.')

  // (e) RESTORE → the reconciler must RE-ATTACH the simulator with fresh geometry.
  await mainWin.webContents.executeJavaScript(`window.__demoShowSim(); window.__demoSetSplit(300)`)
  await sleep(600)
  await shot(mainWin, '5-sim-restored.png')
  const restored = await captureSimBounds()
  const simRestored = !!restored.sim && restored.sim.width > 100
  log('STEP5: after restore, native bounds =', JSON.stringify(restored))
  if (simRestored) log('✅ renderer-driven restore RE-ATTACHED the native simulator (visible:true → reconcile attach).')
  else log('❌ simulator did NOT re-attach on restore.')

  // (f) STRESS: a burst of rapid re-splits (the white-screen bug's shape). With the
  // level-triggered publisher+reconciler the blocks must SETTLE correctly — no view
  // stuck detached. Assert both native blocks are visible with sane geometry after.
  await mainWin.webContents.executeJavaScript(`window.__demoStress(40)`)
  await sleep(800)
  await shot(mainWin, '6-after-stress.png')
  const settled = await captureSimBounds()
  const bothLive = !!settled.sim && !!settled.dev && settled.sim.width > 40 && settled.dev.width > 40
  log('STEP6: after 40-round stress, native bounds =', JSON.stringify(settled))
  if (bothLive) log('✅ after a 40-round relayout burst BOTH native blocks are correctly placed (level-triggered self-heal — no stuck detached view).')
  else log('❌ a native block was stuck detached after the stress burst — the white-screen failure mode.')

  log('ALL STEPS DONE')
}

function captureSimBounds() {
  const out = {}
  for (const blk of placedBlocks) {
    if (blk.handle.webContents.isDestroyed()) continue
    const b = blk.handle.bounds()
    if (!b) continue
    out[blk.label === 'SIMULATOR' ? 'sim' : 'dev'] = { x: b.x, width: b.width }
  }
  return Promise.resolve(out)
}

void allDone.then(async () => {
  await sleep(200)
  quitting = true   // tell onClose to STOP vetoing — we are tearing down for real
  app.quit()
})

app.on('window-all-closed', () => app.quit())
process.on('uncaughtException', (e) => { console.error('[demo] UNCAUGHT', e); app.quit() })
