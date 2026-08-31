/**
 * Runs the WeChat label-semantics probe against our own devtools through the
 * miniprogram-automator client, so both tools are measured with the same mini
 * program and the same driver API.
 *
 * The expected sequences are the numbers measured on WeChat DevTools with the
 * same probe (`/Volumes/jdisk/code/dimina-label-semantics-probe`): each case
 * asserts the full ordered event log, not just counts, because several cases
 * differ only in ordering.
 *
 * Touch is the faithful injection path: `Element.tap` synthesises a framework
 * tap with no touch payload, which cannot drive long-press or drag-cancel.
 * Every case here drives `touchstart`/`touchmove`/`touchend`. Native focus is
 * the one thing no protocol command can reach — the browser grants it only to
 * trusted gestures — so case N is measured both ways.
 */

import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  RENDER_GUEST_URL_MARKER,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const automator = require('miniprogram-automator')

const PROBE_APP_DIR = path.resolve(__dirname, 'fixtures', 'label-probe-app')

/** Long enough to pass the 350ms long-press threshold with margin, as the WeChat run did. */
const HOLD_MS = 1000

interface AutomatorElement {
  offset(): Promise<{ left: number; top: number }>
  size(): Promise<{ width: number; height: number }>
  touchstart(options?: unknown): Promise<void>
  touchmove(options?: unknown): Promise<void>
  touchend(options?: unknown): Promise<void>
}

interface AutomatorPage {
  data(path?: string): Promise<unknown>
  $(selector: string): Promise<AutomatorElement | null>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let electronApp: ElectronApplication
let mainWindow: PwPage
let miniProgram: { currentPage(): Promise<AutomatorPage>; disconnect(): void }
let page: AutomatorPage

// ── Probe plumbing ────────────────────────────────────────────────────

async function element(selector: string): Promise<AutomatorElement> {
  const el = await page.$(selector)
  if (!el) throw new Error(`probe element not found: ${selector}`)
  return el
}

/** Strip the `N. ` sequence prefix the probe prepends to each log entry. */
function stripIndex(entry: string): string {
  return entry.replace(/^\d+\.\s*/, '')
}

async function readLog(): Promise<string[]> {
  return ((await page.data('log')) as string[] | undefined) ?? []
}

/**
 * Read the event log once it stops growing. Several cases assert that something
 * did NOT happen, so the read must outlast any late event rather than sample the
 * log the moment the first one lands.
 */
async function settledLog(): Promise<string[]> {
  const started = Date.now()
  const deadline = started + 8000
  let previous: string | null = null
  let stableSince = 0
  for (;;) {
    const log = await readLog()
    const serialized = log.join('|')
    if (serialized === previous) {
      if (Date.now() - stableSince >= 600 && Date.now() - started >= 900) {
        return log.map(stripIndex)
      }
    } else {
      previous = serialized
      stableSince = Date.now()
    }
    if (Date.now() > deadline) return log.map(stripIndex)
    await sleep(120)
  }
}

/** Drive the probe's own 清零 button, the same way the manual runs zeroed counters. */
async function resetCounters(): Promise<void> {
  const button = await element('.reset')
  await button.touchstart()
  await button.touchend()
  await pollUntil(
    async () => (await readLog()).length,
    (n) => n === 0,
    5000,
    150,
  )
}

/**
 * The finger's landing point, read once. Omitting the points lets the protocol
 * fall back to the element's centre, but it re-reads live layout on every event
 * — and the probe page grows a log row per event, so the same finger would come
 * back at a different coordinate and read as a drag. A real finger keeps its
 * screen position while the page reflows under it.
 */
async function fingerPoint(el: AutomatorElement) {
  const { left, top } = await el.offset()
  const { width, height } = await el.size()
  const x = Math.round(left + width / 2)
  const y = Math.round(top + height / 2)
  return { identifier: 0, pageX: x, pageY: y, clientX: x, clientY: y }
}

async function tap(selector: string): Promise<string[]> {
  await resetCounters()
  const el = await element(selector)
  const point = await fingerPoint(el)
  await el.touchstart({ touches: [point], changeTouches: [point] })
  await el.touchend({ touches: [], changeTouches: [point] })
  return settledLog()
}

/**
 * Touch at the element's own centre. A picker column reads the touch point to
 * decide which row was hit, so it needs real coordinates rather than the
 * origin-anchored default.
 */
async function touchTapCentre(selector: string): Promise<string[]> {
  await resetCounters()
  const el = await element(selector)
  const point = await fingerPoint(el)
  await el.touchstart({ touches: [point], changeTouches: [point] })
  await sleep(60)
  await el.touchend({ touches: [], changeTouches: [point] })
  return settledLog()
}

/** Touch down at the element's centre and drag `dy` pixels vertically before releasing. */
async function dragVertically(selector: string, dy: number): Promise<string[]> {
  await resetCounters()
  const el = await element(selector)
  const { left, top } = await el.offset()
  const { width, height } = await el.size()
  const x = Math.round(left + width / 2)
  const startY = Math.round(top + height / 2)
  const at = (y: number) => ({ identifier: 0, pageX: x, pageY: y, clientX: x, clientY: y })
  await el.touchstart({ touches: [at(startY)], changeTouches: [at(startY)] })
  const steps = 6
  for (let step = 1; step <= steps; step++) {
    const point = at(Math.round(startY + (dy * step) / steps))
    await el.touchmove({ touches: [point], changeTouches: [point] })
    await sleep(16)
  }
  const released = at(Math.round(startY + dy))
  await el.touchend({ touches: [], changeTouches: [released] })
  return settledLog()
}

/**
 * Click through Electron's own input pipeline instead of the automation
 * protocol. Native focus only follows a trusted user gesture, so a control that
 * takes focus from the browser rather than from framework code is unreachable
 * through the protocol's synthesised touch events — that path is the only way to
 * measure what a real finger does. Returns the focused tag as the discriminator.
 */
async function trustedClick(selector: string): Promise<string> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL().includes(payload.marker))
    if (!target) throw new Error('render guest webContents not found')
    const json = await target.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(payload.selector)});
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`) as string
    if (json === 'null') throw new Error(`probe element not found in guest: ${payload.selector}`)
    const point = JSON.parse(json) as { x: number, y: number }
    const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left' as const, clickCount: 1 }
    target.sendInputEvent({ ...base, type: 'mouseMove' })
    target.sendInputEvent({ ...base, type: 'mouseDown' })
    await new Promise((r) => setTimeout(r, 40))
    target.sendInputEvent({ ...base, type: 'mouseUp' })
    await new Promise((r) => setTimeout(r, 300))
    return target.executeJavaScript(
      `(() => (document.activeElement && document.activeElement.tagName) || '')()`,
    ) as Promise<string>
  }, { marker: RENDER_GUEST_URL_MARKER, selector })
}

async function hold(selector: string): Promise<string[]> {
  await resetCounters()
  const el = await element(selector)
  const point = await fingerPoint(el)
  await el.touchstart({ touches: [point], changeTouches: [point] })
  await sleep(HOLD_MS)
  await el.touchend({ touches: [], changeTouches: [point] })
  return settledLog()
}

// ── Setup / teardown ──────────────────────────────────────────────────

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    __dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata',
    `label-probe-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })
  electronApp = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })

  const autoPort = await pollUntil(
    () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  ) as number

  await openProjectInUI(mainWindow, PROBE_APP_DIR, { waitMs: 8000 })
  await waitForSimulatorWebview(electronApp)

  miniProgram = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${autoPort}` })
  page = await pollUntil(
    async () => {
      const p = await miniProgram.currentPage().catch(() => null)
      if (!p) return null
      // The probe's own markup is the readiness signal: an attached page whose
      // counter panel is queryable is one the touch commands can reach.
      return (await p.$('.reset').catch(() => null)) ? p : null
    },
    (p) => p !== null,
    30000,
    500,
  ) as AutomatorPage
})

test.afterAll(async () => {
  miniProgram?.disconnect()
  await closeProject(mainWindow).catch(() => {})
  await electronApp?.close().catch(() => {})
})

// ── Cases ─────────────────────────────────────────────────────────────

test.describe('label activation semantics, measured against the WeChat probe', () => {
  test.setTimeout(180_000)
  test.describe.configure({ mode: 'serial' })

  test('A-1 tapping label text activates the control without giving it a tap', async () => {
    expect(await tap('.t-a')).toEqual(['switchA.change=true', 'labelA.tap', 'viewA.tap'])
  })

  test('A-2 tapping the control body emits its own tap and does not re-activate', async () => {
    expect(await tap('.t-a-switch')).toEqual([
      'switchA.change=true', 'switchA.tap', 'labelA.tap', 'viewA.tap',
    ])
  })

  test('B for= activates the remote control without touching its ancestors', async () => {
    expect(await tap('.t-b')).toEqual(['switchB.change=true', 'labelB.tap'])
  })

  test('C several controls activate the first one in document order', async () => {
    expect(await tap('.t-c')).toEqual(['switchC.change=true', 'labelC.tap'])
  })

  test('D a lone native input takes focus from the label tap', async () => {
    expect(await tap('.t-d')).toEqual(['inputD.focus', 'labelD.tap'])
  })

  test('E a long press suppresses the tap and with it the activation', async () => {
    expect(await hold('.t-e')).toEqual([
      'labelE.touchstart', 'labelE.longtap', 'labelE.longpress', 'labelE.touchend',
    ])
  })

  test('F dragging out of the label cancels the tap and the activation', async () => {
    await resetCounters()
    const el = await element('.t-f')
    const { left, top } = await el.offset()
    const { height } = await el.size()
    const rowHeight = Number(height)
    expect(rowHeight).toBeGreaterThan(0)

    await el.touchstart()
    await sleep(HOLD_MS)
    // Two moves far past the 10px cancel threshold, expressed in the row's own
    // height so the drag stays out of the label whatever the layout metrics are.
    let last = { identifier: 0, clientX: left, clientY: top }
    for (const rows of [4, 8]) {
      last = { identifier: 0, clientX: left, clientY: top + rowHeight * rows }
      await el.touchmove({ touches: [last] })
    }
    await el.touchend({ touches: [], changeTouches: [last] })

    expect(await settledLog()).toEqual([
      'labelF.touchstart', 'labelF.longtap', 'labelF.longpress',
      'labelF.canceltap', 'labelF.canceltap', 'labelF.touchend',
    ])
  })

  test('G an activated button emits a tap that bubbles through the label ancestors', async () => {
    expect(await tap('.t-g')).toEqual([
      'buttonG.tap', 'labelG.tap', 'viewG.tap', 'labelG.tap', 'viewG.tap',
    ])
  })

  test('H a remote button bubbles its tap through its own ancestors', async () => {
    expect(await tap('.t-h')).toEqual(['buttonH.tap', 'viewH.tap', 'labelH.tap'])
  })

  test('I a disabled first control stops the search instead of skipping ahead', async () => {
    expect(await tap('.t-i')).toEqual(['labelI.tap', 'viewI.tap'])
  })

  test('J longtap alone does not suppress the tap, so activation still happens', async () => {
    expect(await hold('.t-j')).toEqual([
      'labelJ.longtap', 'switchJ.change=true', 'labelJ.tap',
    ])
  })

  test('K tapping the button body does not re-activate through the label', async () => {
    expect(await tap('.t-k-button')).toEqual(['buttonK.tap', 'labelK.tap', 'viewK.tap'])
  })

  test('L catchtap on the label stops the re-emitted tap like any other', async () => {
    expect(await tap('.t-l')).toEqual(['buttonL.tap', 'labelL.tap', 'labelL.tap'])
  })

  test('M the re-emitted tap carries the same touch payload as the label tap', async () => {
    const log = await tap('.t-m')
    expect(log).toHaveLength(3)
    const [buttonEntry, labelEntry] = log
    expect(buttonEntry!.startsWith('buttonM.tap ')).toBe(true)
    expect(labelEntry!.startsWith('labelM.tap ')).toBe(true)
    // The payload is everything after the event key; equality is the claim.
    const payload = (entry: string) => entry.slice(entry.indexOf('.tap ') + 5)
    expect(payload(buttonEntry!)).toBe(payload(labelEntry!))
    expect(log[2]).toBe(log[1])
  })

  test('N tapping a later control leaves the earlier one alone', async () => {
    // The guard is what this case exists to pin down: the tap landed on the
    // input, so the switch ahead of it must not be activated.
    expect(await tap('.t-c-input')).toEqual(['labelC.tap'])
  })

  test('N a real click on that later control also focuses it', async () => {
    // Same case through the input pipeline, matching WeChat's numbers exactly.
    // The protocol's touch events reach the framework but not the browser's
    // focus machinery, which is why the case above stops one entry short.
    await resetCounters()
    expect(await trustedClick('.t-c-input')).toBe('INPUT')
    expect(await settledLog()).toEqual(['inputC.focus', 'labelC.tap'])
  })

  // The change handler sits on the group, so the event must name the group and
  // not the item that was selected. Both keys are read off `currentTarget`.
  // Each of these taps its control exactly once in the run: a second tap would
  // find the item already selected and produce no change at all.
  test('O selecting a radio names the radio-group as the event owner', async () => {
    expect(await tap('.t-o-radio')).toEqual(['groupO.change=o1', 'radioO.tap', 'labelO.tap', 'viewO.tap'])
  })

  test('P checking a checkbox names the checkbox-group as the event owner', async () => {
    expect(await tap('.t-p-checkbox')).toEqual(['groupP.change=p1', 'checkboxP.tap', 'labelP.tap', 'viewP.tap'])
  })

  test('Q a textarea is not a control a label can activate', async () => {
    expect(await tap('.t-q')).toEqual(['labelQ.tap', 'viewQ.tap'])
  })

  test('Q tapping the textarea body is not treated as tapping a control either', async () => {
    expect(await tap('.t-q-textarea')).toEqual(['labelQ.tap', 'viewQ.tap'])
  })

  test('R for= wins over the control inside the label', async () => {
    expect(await tap('.t-r')).toEqual(['switchRemoteR.change=true', 'labelR.tap'])
  })

  test('S a for= pointing at nothing does not fall back to the control inside', async () => {
    expect(await tap('.t-s')).toEqual(['labelS.tap', 'viewS.tap'])
  })

  test('T a hidden first control is still the one the search finds', async () => {
    expect(await tap('.t-t')).toEqual(['switchHiddenT.change=true', 'labelT.tap', 'viewT.tap'])
  })

  test('U nested labels each activate their own control', async () => {
    expect(await tap('.t-u')).toEqual([
      'switchInnerU.change=true', 'labelInnerU.tap',
      'switchOuterU.change=true', 'labelOuterU.tap', 'viewU.tap',
    ])
  })

  // V and W pin down what "not a control" means for the two components that
  // carry no label-target behaviour: the search walks past them, and a tap on
  // their body is not a tap on a control, so the label activates all the same.
  // Each pair taps the same switch twice; the probe's 清零 puts the switch data
  // back to false, so both readings start from the same state.
  test('V the search walks past a textarea to the control behind it', async () => {
    expect(await tap('.t-v')).toEqual(['switchV.change=true', 'labelV.tap', 'viewV.tap'])
  })

  test('V tapping the textarea body still activates the control behind it', async () => {
    expect(await tap('.t-v-textarea')).toEqual(['switchV.change=true', 'labelV.tap', 'viewV.tap'])
  })

  test('W the search walks past a slider to the control behind it', async () => {
    expect(await tap('.t-w')).toEqual(['switchW.change=true', 'labelW.tap', 'viewW.tap'])
  })

  test('W tapping the slider body still activates the control behind it', async () => {
    // The slider seeks to the tap and raises its own change first, ahead of the
    // activation, which is also WeChat's order. The value only reflects where on
    // the track the tap lands — here, the centre.
    expect(await tap('.t-w-slider')).toEqual([
      'sliderW.change=50', 'switchW.change=true', 'labelW.tap', 'viewW.tap',
    ])
  })

  // X and Y are the same ownership question as O and P for the other two
  // containers: the handler sits on the form / picker-view, so the event must
  // name it and not the button or the list item that triggered it.
  test('X submit names the form, not the button that triggered it', async () => {
    expect(await tap('.t-x-submit')).toEqual(['buttonSubmitX.tap', 'formX.submit'])
  })

  test('Y a column change names the picker-view', async () => {
    expect(await touchTapCentre('.t-y-item1')).toEqual(['pickerY.change'])
  })

  test('Y dragging the column raises exactly one change', async () => {
    // The user path is a drag, and it settles once: one change for the whole
    // gesture, none for the scroll animation that follows it. The drag is
    // dispatched on an item because the column's touch handlers sit on the
    // scrolling content, which the column's own root does not bubble into.
    expect(await dragVertically('.t-y-item0', -50)).toEqual(['pickerY.change'])
  })

  // The guard looks only at the stretch between the tapped node and the label:
  // a control wrapping the label from outside is not part of that walk, so it
  // does not suppress the activation.
  test('Z a button wrapping the label does not suppress the activation', async () => {
    expect(await tap('.t-z')).toEqual(['switchZ.change=true', 'labelZ.tap', 'buttonZ.tap', 'viewZ.tap'])
  })
})
