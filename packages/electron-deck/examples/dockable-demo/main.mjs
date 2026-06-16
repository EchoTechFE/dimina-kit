// electron-deck DOCKABLE demo — host (offscreen, self-verifying).
//
// This is the P-1 fallback deliverable: a standalone Electron example proving
// the NEW React `<DockView>` dock-shell adapter drives a real docking UI with a
// native WebContentsView FOLLOWING a DOM slot, plus serialize/restore.
//
// Host wiring mirrors layout-demo/main.mjs (startElectronDeck, offscreen
// showInactive at -3000, native block via runtime.view().placeIn, composite
// screenshots, captureRetry). The KEY DIFFERENCE: the renderer DOM is driven by
// React <DockView> (not hand-rolled DOM), and the native simulator block is
// anchored to the dock's native slot selector [data-deck-native-slot="simulator"].
//
// Run offscreen:  electron examples/dockable-demo/main.mjs
//
// Proves (with explicit ✅/❌ trace lines):
//   1. DOM tab switch — clicking [data-deck-tab="logs"] flips g-right active to
//      'logs' in the model AND swaps the DOM body.
//   2. Native slot following — resizing the dock host (renderer-driven) moves
//      the native simulator WebContentsView to track its slot rect.
//   3. Serialize/restore — serialize (after tab switch + movePanel), teardown,
//      parseLayout + validateTree, rebuild a fresh model+DockView, assert the
//      restored DOM reflects the persisted tree.

import { app, ipcMain } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'

import { startElectronDeck } from '../../dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
const BLOCK = pathToFileURL(join(HERE, '..', 'layout-demo', 'block.html')).href
const INDEX = pathToFileURL(join(HERE, 'index.html')).href
const PRELOAD = join(HERE, 'preload.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Unbuffered trace (survives a hang — main stdout is block-buffered when piped).
const TRACE = join(SHOTS, 'trace.log')
const log = (...a) => {
	const line =
		'[demo] ' +
		a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
	console.log(line)
	try {
		appendFileSync(TRACE, line + '\n')
	} catch {}
}

// ── composite-screenshot machinery (host page + native block in z-order) ──────
let compositeReq = 0
const compositeWaiters = new Map()
ipcMain.on('demo:composite-result', (_e, reqId, dataUrl) => {
	const res = compositeWaiters.get(reqId)
	if (res) {
		compositeWaiters.delete(reqId)
		res(dataUrl)
	}
})

const placedBlocks = [] // { handle, label, zone }

// Offscreen capturePage() of native WebContentsViews is finicky (UnknownVizError
// right after a layout change). Retry with a short settle — harness concern.
async function captureRetry(capturer, label, tries = 5) {
	let lastErr
	for (let i = 0; i < tries; i++) {
		try {
			return await capturer()
		} catch (e) {
			lastErr = e
			await sleep(300)
		}
	}
	log(`capture failed after ${tries} tries (${label}): ${String(lastErr)}`)
	throw lastErr
}

async function shot(win, name) {
	try {
		const hostImg = await captureRetry(() => win.webContents.capturePage(), 'host')
		const ordered = [...placedBlocks].sort((a, b) => a.zone - b.zone)
		const blocks = []
		for (const blk of ordered) {
			if (blk.handle.webContents.isDestroyed()) continue
			const b = blk.handle.bounds()
			if (!b || b.width === 0 || b.height === 0) continue
			const png = (await captureRetry(() => blk.handle.capturePage(), blk.label)).toDataURL()
			blocks.push({ png, x: b.x, y: b.y, width: b.width, height: b.height, label: blk.label })
		}
		const reqId = ++compositeReq
		const done = new Promise((res) => compositeWaiters.set(reqId, res))
		win.webContents.send('demo:composite', reqId, hostImg.toDataURL(), blocks)
		const dataUrl = await done
		const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
		await writeFile(join(SHOTS, name), buf)
		log('shot →', name, `(${blocks.length} native blocks)`)
	} catch (e) {
		// Screenshots are NICE-TO-HAVE; bounds deltas are the authoritative proof.
		log('shot skipped (capture flaky):', name, String(e))
	}
}

mkdirSync(SHOTS, { recursive: true })
log('boot: about to call startElectronDeck()')

let resolveDone
let quitting = false
const allDone = new Promise((r) => {
	resolveDone = r
})

// Renderer signals readiness (React mounted + client live) via demo:ready.
let resolveReady
const rendererReady = new Promise((r) => {
	resolveReady = r
})
ipcMain.once('demo:ready', () => {
	log('renderer: demo:ready received')
	resolveReady()
})

const { ready } = startElectronDeck({
	app: {
		window: { width: 900, height: 520, show: false, backgroundColor: '#1e1e2e' },
		source: { url: INDEX },
	},
	backend: {
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
			const main = runtime.windows.main
			if (!main) {
				log('assemble: runtime.windows.main is null — aborting')
				resolveDone()
				return
			}
			const mainWin = main.window

			mainWin.webContents.on('preload-error', (_e, path, err) => {
				log('[preload-error]', path, String(err))
			})
			mainWin.webContents.on('console-message', (_e, _lvl, message) => {
				if (/error|deck|slot|✅|❌/i.test(message)) log('[renderer-console]', message)
			})

			// ── open-project handler: REGISTER EARLY (before the load-wait). The
			// renderer's bindNativeSlot fires demo:open-project automatically on the
			// FIRST native-slot mount, which races the page load — registering the
			// handler here (not after the await) means that early send is never
			// dropped. Places ONE native block anchored to the DOCK's native slot
			// selector. The renderer's createDeckLayoutClient measures that selector
			// and threads placements back — the framework moves the WCV. We write NO
			// resize code; geometry is 100% renderer (DockView) driven.
			let session = null
			ipcMain.on('demo:open-project', (_e, projectId) => {
				if (placedBlocks.length) return
				log('open-project:', projectId)
				session = main.newSession()
				const handle = runtime
					.view({ source: { url: `${BLOCK}#${enc('#c0392b', 'SIMULATOR')}` }, scope: session })
					.placeIn(mainWin, { zone: 0, anchor: '[data-deck-native-slot="simulator"]' })
				placedBlocks.push({ handle, label: 'SIMULATOR', zone: 0 })
				log('placed native SIMULATOR view; placedBlocks =', String(placedBlocks.length))
			})

			main.onClose(async () => {
				if (quitting) return 'close'
				if (session) {
					await session.reset()
					session = null
					return 'keep'
				}
				return 'close'
			})

			// Wait for the framework-driven source load to settle (so child WCVs
			// composite into capturePage after showInactive).
			if (mainWin.webContents.isLoading()) {
				log('assemble: awaiting source load')
				await new Promise((res) => {
					const done = (tag) => (...a) => {
						mainWin.webContents.off('did-finish-load', finish)
						mainWin.webContents.off('did-fail-load', fail)
						res()
						if (tag === 'fail') log('[did-fail-load]', ...a.slice(1).map(String))
					}
					const finish = done('finish')
					const fail = done('fail')
					mainWin.webContents.once('did-finish-load', finish)
					mainWin.webContents.once('did-fail-load', fail)
				})
				log('assemble: source load settled')
			}

			// showInactive() offscreen → real paint, no focus/visibility.
			mainWin.setPosition(-3000, -3000)
			mainWin.showInactive()

			void runVerification(mainWin).then(resolveDone).catch((err) => {
				log('verification failed: ' + (err && err.stack ? err.stack : String(err)))
				resolveDone()
			})
		},
	},
})

ready.catch((err) => {
	log('startElectronDeck failed: ' + String(err))
	app.quit()
})

function enc(color, label) {
	return encodeURIComponent(`${color}|${label}`)
}

function simBounds() {
	for (const blk of placedBlocks) {
		if (blk.label !== 'SIMULATOR') continue
		if (blk.handle.webContents.isDestroyed()) return null
		const b = blk.handle.bounds()
		return b ? { x: b.x, width: b.width } : null
	}
	return null
}

// ── offscreen verification: the three proofs ─────────────────────────────────
async function runVerification(mainWin) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)

	// Wait for the React app to mount + open the project (places the native block).
	await rendererReady
	// Give the open-project IPC + placeIn + SlotGrant + anchor measure a beat.
	await sleep(800)
	await shot(mainWin, '1-initial.png')

	// ── PROOF 1: DOM tab switch ───────────────────────────────────────────────
	// Click the logs tab in g-right; assert model g-right active === 'logs' AND
	// the DOM body swapped (logs body present, editor body gone).
	log('── PROOF 1: DOM tab switch (g-right editor → logs) ──')
	const beforeActive = await js(`window.__deck.activeOf('g-right')`)
	await js(`document.querySelector('[data-deck-tab="logs"]').click()`)
	await sleep(300)
	const afterActive = await js(`window.__deck.activeOf('g-right')`)
	const logsBodyPresent = await js(
		`!!document.querySelector('[data-deck-panel-body="logs"] [data-test-dom-content="logs"]')`,
	)
	const editorBodyGone = await js(
		`!document.querySelector('[data-deck-panel-body="editor"]')`,
	)
	const tabActive = await js(
		`document.querySelector('[data-deck-tab="logs"]').getAttribute('data-active') === 'true'`,
	)
	log('PROOF1: g-right active', beforeActive, '→', afterActive, '| logsBody', String(logsBodyPresent), '| editorGone', String(editorBodyGone), '| tabActive', String(tabActive))
	if (afterActive === 'logs' && logsBodyPresent && editorBodyGone && tabActive) {
		log('✅ DOM tab switch: clicking [data-deck-tab="logs"] flipped the model AND swapped the DOM body.')
	} else {
		log('❌ DOM tab switch did NOT propagate to the model/DOM.')
	}
	await shot(mainWin, '2-after-tab-switch.png')

	// ── PROOF 2: native slot following ────────────────────────────────────────
	// Resize the dock host (renderer-driven): react-resizable-panels re-distributes
	// the left (simulator) panel → the native slot rect changes → the view-anchor
	// re-publishes → the framework moves the native WCV. Assert the native sim
	// block's width SHRANK to track its slot. Zero host resize code.
	log('── PROOF 2: native slot following (renderer-driven resize) ──')
	await js(`window.__deck.setHostWidth(880)`)
	await sleep(700)
	const before = simBounds()
	log('PROOF2: native sim bounds @hostWidth=880 :', JSON.stringify(before))
	await js(`window.__deck.setHostWidth(520)`)
	await sleep(700)
	const after = simBounds()
	log('PROOF2: native sim bounds @hostWidth=520 :', JSON.stringify(after))
	await shot(mainWin, '3-after-resize.png')

	// The left panel is ~half the dock host (rrp 50/50). Host 880→520 shrinks the
	// left region by ~180px; the native sim slot (minus CSS margins) tracks it.
	const simDelta = before && after ? before.width - after.width : 0
	const simTracked = simDelta > 100 && simDelta < 260 // ~180 expected, generous band
	log('PROOF2: native sim widthΔ =', String(simDelta), '(expect ~180; band 100..260)')
	if (simTracked) {
		log('✅ native slot following: the native simulator WCV tracked the dock slot rect (renderer-driven geometry, zero host resize code).')
	} else {
		log('❌ native simulator block did NOT follow the dock slot resize.')
	}

	// ── PROOF 3: serialize / restore ──────────────────────────────────────────
	// Move 'logs' to the left group (cross-group move via the model API), then
	// serialize → teardown → parse+validate → rebuild fresh. Assert the restored
	// DOM reflects the persisted tree: g-right active was 'logs' before the move;
	// after the move 'logs' lives in g-left. The restored tree must preserve that
	// 'logs' is in g-left and that the previously-activated state round-tripped.
	log('── PROOF 3: serialize / restore ──')
	// First restore the simulator slot to a sane width so re-mount re-anchors.
	await js(`window.__deck.setHostWidth(900)`)
	await sleep(200)
	// move logs into the left group (so the persisted tree differs from default).
	await js(`window.__deck.moveLogsLeft()`)
	await sleep(200)
	const preLogsInLeft = await js(
		`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="logs"]')`,
	)
	const persistedJson = await js(`window.__deck.serializeLayout(window.__deck.model().get())`)
	log('PROOF3: pre-restore — logs tab in g-left:', String(preLogsInLeft))
	log('PROOF3: serialized tree:', persistedJson)

	const restore = await js(`window.__deck.serializeRestore()`)
	if (!restore.ok) {
		log('PROOF3: parseLayout/validateTree FAILED:', JSON.stringify(restore.problems))
		log('❌ serialize/restore: validation rejected the persisted tree.')
	} else {
		await sleep(400)
		const postLogsInLeft = await js(
			`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="logs"]')`,
		)
		const postSimSlot = await js(
			`!!document.querySelector('[data-deck-native-slot="simulator"]')`,
		)
		log('PROOF3: post-restore — logs tab in g-left:', String(postLogsInLeft), '| native slot present:', String(postSimSlot))
		if (postLogsInLeft && postSimSlot) {
			log('✅ serialize/restore: persisted tree round-tripped through serializeLayout→parseLayout→validateTree and the rebuilt DockView reflects it (logs in g-left, native slot intact).')
		} else {
			log('❌ serialize/restore: restored DOM did NOT reflect the persisted tree.')
		}
	}
	await shot(mainWin, '4-after-restore.png')

	log('ALL STEPS DONE')
}

void allDone.then(async () => {
	await sleep(200)
	quitting = true
	app.quit()
})

app.on('window-all-closed', () => app.quit())
process.on('uncaughtException', (e) => {
	console.error('[demo] UNCAUGHT', e)
	try {
		appendFileSync(TRACE, '[demo] UNCAUGHT ' + String(e && e.stack ? e.stack : e) + '\n')
	} catch {}
	app.quit()
})
