/**
 * Native-host coverage for the canvas gesture contract. Pointer events are
 * dispatched in the render guest because the host window stays off-screen and
 * does not participate in OS hit-testing. The suite verifies the DOM contract:
 * canvas-relative touch coordinates survive the bridge and Canvas touch/tap
 * events carry currentTarget and bubble normally to ancestors.
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
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'canvas-interaction-app')
const APP_ID = 'devtools_canvas_interaction_fixture' // fixtures/canvas-interaction-app/project.config.json appid

let electronApp: ElectronApplication
let mainWindow: PwPage

interface TouchSnapshot {
  identifier: number
  x?: number
  y?: number
  pageX: number
  pageY: number
  clientX: number
  clientY: number
}

interface EventSnapshot {
  type: string
  hasCurrentTarget: boolean
  detail: { x?: number, y?: number } | null
  touch0: TouchSnapshot | null
  changed0: TouchSnapshot | null
  touchCount: number
}

interface Rect { x: number, y: number, width: number, height: number }

/** Geometry of the canvas inside the render-host guest, in that guest's own
 * viewport coordinates — the space `sendPointer` dispatches into. */
async function elementRect(selector: string): Promise<Rect> {
  return evalInWebContentsByUrl<Rect>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) throw new Error(${JSON.stringify(`${selector} not found in render-host guest`)})
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`,
  )
}

async function canvasRect(): Promise<Rect> {
  return elementRect('canvas[canvas-id="hitCanvas"]')
}

/** Dispatch a synthesized `PointerEvent` inside the render-host guest — see
 * the file header for why this replaces `webContents.sendInputEvent`.
 * `pointerdown` targets whatever element is actually under the point (so it
 * naturally lands on the canvas, matching `useTouchEvents.js`'s own
 * `elementRef`-scoped listener); `pointermove`/`pointerup` dispatch on
 * `document`, matching the document-scoped tracking `onPointerDown` installs
 * for the rest of the sequence. */
async function sendPointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): Promise<void> {
  const dispatched = await evalInWebContentsByUrl<boolean>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const type = ${JSON.stringify(type)}
      const x = ${x}
      const y = ${y}
      const init = {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        bubbles: true,
        cancelable: true,
        composed: true,
      }
      const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : document
      if (!target) return false
      target.dispatchEvent(new PointerEvent(type, init))
      return true
    })()`,
  )
  if (!dispatched) throw new Error(`no element under (${x}, ${y}) in the render-host guest for ${type}`)
}

async function resetLog(): Promise<void> {
  await evalInWebContentsByUrl<boolean>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    `(() => {
      const el = document.querySelector('[data-action="reset"]')
      if (el && typeof el.click === 'function') { el.click(); return true }
      return false
    })()`,
  )
  await pollUntil(
    () => getPageData(electronApp, APP_ID, 'log').catch(() => undefined),
    (v) => Array.isArray(v) && v.length === 0,
    10000,
    200,
  )
}

async function waitForLogEntry(entry: string): Promise<string[]> {
  await pollUntil(
    () => getPageData(electronApp, APP_ID, 'log').catch(() => undefined),
    (v) => Array.isArray(v) && (v as string[]).includes(entry),
    10000,
    150,
  )
  return await getPageData(electronApp, APP_ID, 'log') as string[]
}

async function readLog(): Promise<string[]> {
  return (await getPageData(electronApp, APP_ID, 'log') as string[]) ?? []
}

async function readEvent(key: string): Promise<EventSnapshot | null> {
  return (await getPageData(electronApp, APP_ID, key)) as EventSnapshot | null
}

test.describe('native-host canvas gesture e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-canvas-interaction-${process.pid}`,
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

    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        electronApp,
        RENDER_GUEST_URL_MARKER,
        `(() => !!document.querySelector('canvas[canvas-id="hitCanvas"]'))()`,
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

  test('a real mouse click on the canvas delivers tap with canvas-relative touch coordinates', async () => {
    await resetLog()
    const rect = await canvasRect()
    const px = rect.x + rect.width / 2
    const py = rect.y + rect.height / 2

    await sendPointer('pointerdown', px, py)
    await sendPointer('pointerup', px, py)

    const log = await waitForLogEntry('canvas:tap')
    expect(log, `canvas should receive the full touch sequence, got ${JSON.stringify(log)}`)
      .toEqual(expect.arrayContaining(['canvas:touchstart', 'canvas:touchend', 'canvas:tap']))

    const tap = await readEvent('canvasTap')
    expect(tap).not.toBeNull()

    // detail.x / detail.y are page coordinates, per the official event doc.
    expect(tap!.detail?.x).toBeCloseTo(px, 0)
    expect(tap!.detail?.y).toBeCloseTo(py, 0)

    // Each touch point additionally carries x / y relative to the canvas's own
    // top-left corner — the official CanvasTouch object.
    expect(tap!.touch0).not.toBeNull()
    expect(tap!.touch0!.identifier).toBe(0)
    expect(tap!.touch0!.x).toBeCloseTo(rect.width / 2, 0)
    expect(tap!.touch0!.y).toBeCloseTo(rect.height / 2, 0)
  })

  test('canvas touch and tap events both carry currentTarget', async () => {
    const touchStart = await readEvent('canvasTouchStart')
    const tap = await readEvent('canvasTap')

    expect(touchStart).not.toBeNull()
    expect(touchStart!.hasCurrentTarget, 'canvas touch events carry currentTarget').toBe(true)
    expect(tap!.hasCurrentTarget, 'tap carries currentTarget').toBe(true)
  })

  test('touchend finishes bubbling before tap bubbles through Canvas and ancestor', async () => {
    const log = await readLog()
    expect(log).toEqual([
      'canvas:touchstart',
      'canvas:touchend',
      'outer:touchend',
      'canvas:tap',
      'outer:tap',
    ])
  })

  test('a button catchtap blocks its ancestor during the same pointer sequence', async () => {
    await resetLog()
    const rect = await elementRect('.catch-button')
    const px = rect.x + rect.width / 2
    const py = rect.y + rect.height / 2

    await sendPointer('pointerdown', px, py)
    await sendPointer('pointerup', px, py)

    const log = await waitForLogEntry('catch:button')
    expect(log).not.toContain('catch:outer')
  })

  test('disable-scroll prevents the bare canvas touchmove default', async () => {
    const defaultPrevented = await evalInWebContentsByUrl<boolean>(
      electronApp,
      RENDER_GUEST_URL_MARKER,
      `(() => {
        const canvas = document.querySelector('canvas[canvas-id="hitCanvas"]')
        const point = {
          identifier: 1,
          clientX: 20,
          clientY: 20,
          pageX: 20,
          pageY: 20,
          screenX: 20,
          screenY: 20,
          force: 1,
        }
        const start = new Event('touchstart', { bubbles: true, cancelable: true, composed: true })
        Object.assign(start, { touches: [point], changedTouches: [point], targetTouches: [point] })
        canvas.dispatchEvent(start)
        const moved = { ...point, clientX: 40, pageX: 40, screenX: 40 }
        const move = new Event('touchmove', { bubbles: true, cancelable: true, composed: true })
        Object.assign(move, { touches: [moved], changedTouches: [moved], targetTouches: [moved] })
        canvas.dispatchEvent(move)
        const defaultPrevented = move.defaultPrevented
        const end = new Event('touchend', { bubbles: true, cancelable: true, composed: true })
        Object.assign(end, { touches: [], changedTouches: [moved], targetTouches: [] })
        canvas.dispatchEvent(end)
        return defaultPrevented
      })()`,
    )

    expect(defaultPrevented).toBe(true)
  })

  test('dragging past the move threshold sends canceltap instead of tap', async () => {
    await resetLog()
    const rect = await canvasRect()
    const px = rect.x + 30
    const py = rect.y + 30

    await sendPointer('pointerdown', px, py)
    await sendPointer('pointermove', px + 40, py + 40)
    await sendPointer('pointerup', px + 40, py + 40)

    const log = await waitForLogEntry('canvas:canceltap')
    expect(log, `a drag must not produce a tap, got ${JSON.stringify(log)}`).not.toContain('canvas:tap')
  })

  test('a long press fires longpress and suppresses the tap that would follow', async () => {
    await resetLog()
    const rect = await canvasRect()
    const px = rect.x + rect.width / 2
    const py = rect.y + rect.height / 2

    await sendPointer('pointerdown', px, py)
    await waitForLogEntry('canvas:longpress')
    await sendPointer('pointerup', px, py)

    // touchend arrives after the release; wait for it before asserting on the
    // absence of tap, otherwise this races the bridge round-trip.
    const log = await waitForLogEntry('canvas:touchend')
    expect(log, `longpress must suppress the following tap, got ${JSON.stringify(log)}`)
      .not.toContain('canvas:tap')
    expect(log, `longpress must suppress the ancestor tap too, got ${JSON.stringify(log)}`)
      .not.toContain('outer:tap')
  })
})
