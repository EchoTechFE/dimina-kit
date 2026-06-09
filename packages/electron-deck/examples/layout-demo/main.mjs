// electron-deck layout demo — offscreen, screenshot-driven.
//
// Drives the REAL primitives from packages/electron-deck/dist:
//   createScope / createCompositor  (dist/main)
//   createControlBus + WireTransport + EventBus + createTrustSet  (dist/host)
// behind a paper-thin `runtime` / `ViewHandle` facade (the only stub code here).
//
// Run offscreen:  electron examples/layout-demo/main.mjs
// Windows are created hidden + showInactive() at x:-3000 so they paint without
// ever appearing on the visible desktop or stealing focus. Each step writes a
// composite PNG (host page + native blocks blitted in real compositor z-order)
// to shots/*.png — capturePage() alone omits child WebContentsViews.

import { app, BrowserWindow, WebContentsView } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'

// Import the REAL primitives from the built dist (tsc → ESM). The example lives
// inside the package, so a relative dist path is the robust self-reference (the
// package is not symlinked into node_modules for self-import).
import { createScope, createCompositor } from '../../dist/main/index.js'
import {
  createControlBus,
  createTrustSet,
  WireTransport,
  EventBus,
} from '../../dist/host/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
const BLOCK = pathToFileURL(join(HERE, 'block.html')).href
const CONTROL = pathToFileURL(join(HERE, 'control.html')).href

// Zones: lower renders BELOW higher (compositor total order = (zone,orderKey,id)).
const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[demo]', ...a)

// ──────────────────────────────────────────────────────────────────────────
// Thin facade (the ONLY stub): wraps a window's real Compositor + the real
// Scope tree so the demo can speak runtime.windows.create / view().placeIn()/
// .moveTo() while every lifecycle + z decision is delegated to a real primitive.
// ──────────────────────────────────────────────────────────────────────────

function makeWindowDeck(win, scope, label, bg) {
  // ContentViewHost projection over the real Electron contentView — exactly the
  // surface createCompositor() drives. The compositor speaks NativeViewRef ({id});
  // we resolve id → the live WebContentsView via deck.byId.
  const host = {
    addChildView: (ref) => {
      const vh = deck.byId.get(ref.id)
      if (vh) win.contentView.addChildView(vh.native)
    },
    removeChildView: (ref) => {
      const vh = deck.byId.get(ref.id)
      if (vh) win.contentView.removeChildView(vh.native)
    },
    get isDestroyed() { return win.isDestroyed() },
    children: () =>
      win.contentView.children
        .map((c) => deck.byWc.get(c.webContents?.id))
        .filter(Boolean)
        .map((vh) => ({ id: vh.id })),
  }
  const compositor = createCompositor(host)

  const deck = {
    win,
    scope,          // window-scope (child of root); session = scope.child()
    compositor,
    label,
    bg,
    slotBounds: {}, // id → {x,y,w,h} reported by control.html's anchor
    views: new Set(),
    byWc: new Map(),  // wc.id → ViewHandle (for children() ordering readback)
    byId: new Map(),  // view id  → ViewHandle (for the host add/remove adapter)
  }
  return deck
}

// ViewHandle facade: a NativeViewRef ({id}) for the compositor + the live
// WebContentsView + the scope segment that owns its teardown.
function makeViewHandle(id, color, label) {
  const native = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  })
  native.setBackgroundColor('#00000000')
  native.webContents.loadURL(`${BLOCK}#${encodeURIComponent(`${color}|${label}`)}`)
  return {
    id,
    native,
    color,
    label,
    zone: Z.CONTENT,
    slot: null,     // which control.html slot id it anchors to
    deck: null,     // current owning window-deck
    /** placeIn: real compositor.mount(zone) + commit, anchored to a slot. */
    placeIn(deck, { zone, slot }) {
      this.deck = deck
      this.zone = zone
      this.slot = slot
      deck.views.add(this)
      deck.byWc.set(this.native.webContents.id, this)
      deck.byId.set(this.id, this)
      deck.compositor.mount({ id: this.id }, { zone })
      deck.compositor.commit()
      applyBounds(deck, this)
    },
    /** moveTo (popout = live-migrate): cross-window compositor re-mount +
     *  scope.adopt re-homes the lifetime WITHOUT reset/close (no reload). */
    async moveTo(destDeck, { zone, slot }, sessionScopeOf) {
      const srcDeck = this.deck
      // 1) lifetime: re-parent this view's scope from src session → dest session.
      //    adopt(child, newParent) is called ON the current parent (src session),
      //    and requires `child` be a direct child of it — which vh.scope is.
      const srcSession = sessionScopeOf(srcDeck)
      const destSession = sessionScopeOf(destDeck)
      await srcSession.adopt(this.scope, destSession)
      // 2) compositor: drop from source window, mount into dest window.
      srcDeck.compositor.unmount(this.id)
      srcDeck.compositor.commit()  // detaches the view from win1's contentView
      srcDeck.views.delete(this)
      srcDeck.byWc.delete(this.native.webContents.id)
      srcDeck.byId.delete(this.id)
      this.deck = destDeck
      this.zone = zone
      this.slot = slot
      destDeck.views.add(this)
      destDeck.byWc.set(this.native.webContents.id, this)
      destDeck.byId.set(this.id, this)
      destDeck.compositor.mount({ id: this.id }, { zone })
      destDeck.compositor.commit()
      applyBounds(destDeck, this)
    },
  }
}

// Anchor a native view to its slot's reported rect (the view-anchor publish sink).
function applyBounds(deck, vh) {
  const b = deck.slotBounds[vh.slot]
  if (!b) return
  vh.native.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
}

let compositeReq = 0
const compositeWaiters = new Map()

// Composite snapshot. capturePage() on a window only captures its own web layer;
// child WebContentsViews are composited by the OS window-server, not into the
// offscreen capture. So we capture the host page + each native block separately,
// then have the renderer blit them in the REAL compositor z-order at the views'
// real bounds — reproducing exactly what the window-server would show.
async function shot(deck, name) {
  const win = deck.win
  const hostImg = await win.webContents.capturePage()
  // compositor z-order = win.contentView.children (index 0 = bottom, last = top)
  const ordered = win.contentView.children
    .map((c) => deck.byWc.get(c.webContents?.id))
    .filter(Boolean)
  const blocks = []
  for (const vh of ordered) {
    const b = vh.native.getBounds()
    const png = (await vh.native.webContents.capturePage()).toDataURL()
    blocks.push({ png, x: b.x, y: b.y, width: b.width, height: b.height, label: vh.label })
  }
  const reqId = ++compositeReq
  const done = new Promise((res) => compositeWaiters.set(reqId, res))
  win.webContents.send('demo:composite', reqId, hostImg.toDataURL(), blocks)
  const dataUrl = await done
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  await writeFile(join(SHOTS, name), buf)
  log('shot →', name, `(${blocks.length} native blocks composited:`, blocks.map((b) => b.label).join(' < ') + ')')
}

async function newControlWindow(label, bg) {
  const win = new BrowserWindow({
    width: 760,
    height: 460,
    show: false,        // created hidden so it never flashes on the desktop
    x: -3000,           // parked FAR offscreen (never visible to the user)
    y: -3000,
    backgroundColor: bg,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  })
  await win.webContents.loadURL(CONTROL)
  win.webContents.send('demo:set-label', label, bg)
  // showInactive() at the offscreen coord: forces the compositor to actually
  // PAINT (so child WebContentsViews composite into capturePage) WITHOUT taking
  // focus and WITHOUT appearing on the visible desktop. show:false alone leaves
  // child views uncomposited in the captured frame.
  win.setPosition(-3000, -3000)
  win.showInactive()
  return win
}

// ──────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Real root scope. window-scope = root.child(); session = window-scope.child().
  const root = createScope()

  // ── Real ControlBus stack (command/event/trust over real wire pieces) ──
  // We don't need a live webview RPC for the visual demo, but we build the REAL
  // facade + transport so the control link is genuine, and route the renderer's
  // ipc 'demo:command' into controlBus.command() handlers.
  const bus = new EventBus()
  const trustSet = createTrustSet()
  const controlBus = createControlBus({
    bus,
    trustSet,
    transport: /* placeholder; wire built below referencing controlBus */ null,
  })
  const layoutEvent = controlBus.event('demo:layout') // declared (default-deny otherwise)

  const { ipcMain } = await import('electron')
  const wire = new WireTransport({
    ipcMain,
    bus,
    senderPolicy: { isTrusted: (id) => trustSet.isTrusted(id) },
    trustedWebContents: () => trustSet.snapshot(),
    invokeHost: (name, args) => controlBus.dispatch(name, args),
    invokeSimulator: (name, args) => controlBus.dispatch(name, args),
    declaredEvents: () => controlBus.declaredEvents(),
  })
  wire.start()

  // ── Main window + its window-scope + session-scope ──
  const win1 = await newControlWindow('CONTROL LAYER (main window)', '#1e1e2e')
  const win1Scope = root.child()
  win1Scope.own(() => { if (!win1.isDestroyed()) win1.destroy() })
  trustSet.admit(win1.webContents, win1Scope)

  const deck1 = makeWindowDeck(win1, win1Scope, 'main', '#1e1e2e')
  // expose root on the window-scope so ViewHandle.moveTo can call root.adopt.
  deck1.scope.__rootScope = root

  // session = window-scope.child(): red+blue blocks' scope. session.reset()
  // tears them down (LIFO) while the window survives → "close → main".
  let session1 = win1Scope.child()
  const sessionOf = new WeakMap()
  sessionOf.set(deck1, session1)

  ipcMain.on('demo:composite-result', (_e, reqId, dataUrl) => {
    const res = compositeWaiters.get(reqId)
    if (res) { compositeWaiters.delete(reqId); res(dataUrl) }
  })

  // Track the live slot rects reported by control.html's anchor.
  ipcMain.on('demo:slot-bounds', (e, bounds) => {
    const deck = e.sender === win1.webContents ? deck1 : deck2
    if (!deck) return
    Object.assign(deck.slotBounds, bounds)
    for (const vh of deck.views) applyBounds(deck, vh)
  })

  // ── ViewHandle factory bound to a session scope (its lifetime owner) ──
  function spawnView(deck, sessionScope, { id, color, label, zone, slot }) {
    const vh = makeViewHandle(id, color, label)
    vh.scope = sessionScope.child()
    vh.scope.own(() => { if (!vh.native.webContents.isDestroyed()) vh.native.webContents.close() })
    vh.placeIn(deck, { zone, slot })
    return vh
  }

  // For win2 declared lazily on popout.
  let win2 = null
  let deck2 = null
  let session2 = null

  // ── Real ControlBus command handlers (renderer ipc → command → layout) ──
  // The renderer sends 'demo:command'; we dispatch through controlBus so the
  // command table is the real authority, then publish a declared event back.
  controlBus.command('demo:overlay', () => { void doOverlay(); return 'ok' })
  controlBus.command('demo:reorder', () => { void doReorder(); return 'ok' })
  controlBus.command('demo:popout', () => { void doPopout(); return 'ok' })
  controlBus.command('demo:close', () => { void doClose(); return 'ok' })
  ipcMain.on('demo:command', async (_e, name) => {
    await controlBus.dispatch(`demo:${name}`, [])
    layoutEvent.publish({ applied: name })
  })

  let red, blue, green

  // ── STEP 1: window + two native views into zones ──
  red = spawnView(deck1, session1, { id: 'red', color: '#c0392b', label: 'SIMULATOR', zone: Z.CONTENT, slot: 'simulator' })
  blue = spawnView(deck1, session1, { id: 'blue', color: '#2980b9', label: 'DEVTOOLS', zone: Z.PANEL, slot: 'devtools' })
  await sleep(700)
  await shot(deck1, '1-two-views.png')
  log('STEP1: red(CONTENT)+blue(PANEL) mounted. children order:', deck1.compositorOrder?.() ?? childOrder(deck1))

  // ── STEP 2: overlay floats ABOVE native, parked over devtools corner ──
  async function doOverlay() {
    green = spawnView(deck1, session1, { id: 'green', color: '#27ae60', label: 'OVERLAY', zone: Z.OVERLAY, slot: 'devtools' })
    // shrink it to a corner of the devtools slot so we can see it COVER blue
    const b = deck1.slotBounds.devtools
    if (b) green.native.setBounds({ x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width / 2, height: b.height / 2 })
    await sleep(400)
  }
  await doOverlay()
  await shot(deck1, '2-overlay-over-devtools.png')
  log('STEP2: green(OVERLAY) covers blue. order:', childOrder(deck1))

  // ── STEP 3: reorder blue above green via compositor.reorder + commit ──
  async function doReorder() {
    // move blue into the OVERLAY zone, before nothing → top of overlay (above green)
    deck1.compositor.reorder('blue', { zone: Z.OVERLAY, before: null })
    deck1.compositor.commit()
    // re-anchor blue back over the devtools slot (full) so the swap is visible
    applyBounds(deck1, blue)
    await sleep(300)
  }
  await doReorder()
  await shot(deck1, '3-reorder-blue-top.png')
  log('STEP3: blue reordered above green. order:', childOrder(deck1))

  // ── STEP 4: popout = live-migrate blue → win2 (scope.adopt + cross mount) ──
  async function doPopout() {
    win2 = await newControlWindow('POPOUT WINDOW (win2)', '#3d2c00')
    win2Scope_setup()
    const tickBefore = await blue.native.webContents.executeJavaScript('window.__tick')
    await blue.moveTo(deck2, { zone: Z.PANEL, slot: 'devtools' }, (d) => sessionOf.get(d))
    // sessionOf resolves BOTH src (deck1→session1) and dest (deck2→session2).
    await sleep(500)
    const tickAfter = await blue.native.webContents.executeJavaScript('window.__tick')
    log(`STEP4: blue migrated to win2. counter ${tickBefore} → ${tickAfter} (NOT reset = no reload)`)
  }
  function win2Scope_setup() {
    const win2Scope = root.child()
    win2Scope.own(() => { if (!win2.isDestroyed()) win2.destroy() })
    win2Scope.__rootScope = root
    trustSet.admit(win2.webContents, win2Scope)
    deck2 = makeWindowDeck(win2, win2Scope, 'win2', '#3d2c00')
    deck2.scope.__rootScope = root
    session2 = win2Scope.child()
    sessionOf.set(deck2, session2)
  }
  await doPopout()
  await shot(deck1, '4a-main-after-popout.png')
  await shot(deck2, '4b-win2-after-popout.png')
  log('STEP4: main children:', childOrder(deck1), '| win2 children:', childOrder(deck2))

  // ── STEP 5: close → main. session1.reset() tears red (+green) down LIFO ──
  async function doClose() {
    log('STEP5: session1.reset() — LIFO release of session resources, window survives…')
    await session1.reset()
    log('STEP5: session reset complete; win1 alive =', !win1.isDestroyed(), '; win1Scope.alive =', deck1.scope.alive)
  }
  await doClose()
  await sleep(300)
  await shot(deck1, '5-after-session-reset.png')

  log('ALL STEPS DONE')
  setTimeout(() => app.quit(), 200)
})

function childOrder(deck) {
  return deck.win.contentView.children
    .map((c) => deck.byWc.get(c.webContents?.id))
    .map((vh) => (vh ? `${vh.label}@z${vh.zone}` : '?'))
    .join(' < ')
}

app.on('window-all-closed', () => app.quit())
process.on('uncaughtException', (e) => { console.error('[demo] UNCAUGHT', e); app.quit() })
