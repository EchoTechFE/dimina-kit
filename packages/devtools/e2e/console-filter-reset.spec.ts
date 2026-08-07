import { test, expect, useSharedProject } from './fixtures'
import type { ElectronApplication } from '@playwright/test'
import { DEMO_APP_DIR, pollUntil } from './helpers'
import { buildClearConsoleFilterScript } from '../src/main/services/views/clear-console-filter'

/** Resolve the right-panel Chrome DevTools front-end webContents by its URL. */
async function getRightPanelDevtoolsWcId(electronApp: ElectronApplication): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const front = webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed())
      .find((wc) => wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html'))
    return front ? front.id : null
  })
}

/** Execute JS inside the right-panel DevTools front-end realm. */
async function evalInRightPanelDevtools<T>(electronApp: ElectronApplication, expr: string): Promise<T> {
  const id = await getRightPanelDevtoolsWcId(electronApp)
  if (id === null) throw new Error('right-panel devtools front-end is not attached')
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id, expr }) as Promise<T>
}

/** Whether the Console panel's filter box is reachable right now. */
function boxUsableScript(): string {
  return `(function(){
    try {
      var f = globalThis.Console.ConsoleView.instance().filter;
      return !!(f && f.textFilterUI && typeof f.textFilterUI.setValue === 'function' && typeof f.textFilterUI.value === 'function');
    } catch(e) { return false; }
  })()`
}

/** Current persisted key + visible box value. */
function boxStateScript(): string {
  return `(function(){
    var stored = null;
    try { stored = localStorage.getItem('console.textFilter'); } catch(e) {}
    var box = '';
    try { box = globalThis.Console.ConsoleView.instance().filter.textFilterUI.value(); } catch(e) {}
    return { stored: stored, box: box };
  })()`
}

test.describe('Console filter box is cleared on fresh project open', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  useSharedProject(test, DEMO_APP_DIR)

  test('stale console.textFilter is removed and the box is emptied', async ({ mainWindow, electronApp }) => {
    // Open the Console panel so the embedded Chrome DevTools front-end is mounted.
    const consoleTab = mainWindow.getByRole('tab', { name: 'Console' })
    await consoleTab.click()
    await expect(consoleTab).toHaveAttribute('data-active', 'true')

    // Wait for the front-end realm to attach AND the Console filter box to be usable.
    await pollUntil(
      () => evalInRightPanelDevtools<boolean>(electronApp, boxUsableScript()).catch(() => false),
      (ok) => ok === true,
      30_000,
      300,
    )

    // Seed the stale state the old implementation / DevTools persistence leaves
    // behind: a localStorage key (what we observed on disk) + a live box value.
    const seeded = await evalInRightPanelDevtools<boolean>(electronApp, `(function(){
      try { localStorage.setItem('console.textFilter', '-/^\\\\[service\\\\]|^\\\\[system\\\\]/'); } catch(e) {}
      try {
        var f = globalThis.Console.ConsoleView.instance().filter;
        f.textFilterUI.setValue('-/^\\\\[service\\\\]|^\\\\[system\\\\]/');
        if (typeof f.updateCurrentFilter === 'function') f.updateCurrentFilter();
      } catch(e) { return false; }
      return true;
    })()`)
    expect(seeded).toBe(true)

    const before = await evalInRightPanelDevtools<{ stored: string | null; box: string }>(
      electronApp,
      boxStateScript(),
    )
    expect(before.stored, 'the stale localStorage key should be seeded').toBe('-/^\\[service\\]|^\\[system\\]/')
    expect(before.box, 'the visible box should be seeded').not.toBe('')

    // Run the exact script the project-open injection executes.
    await evalInRightPanelDevtools<void>(electronApp, buildClearConsoleFilterScript())

    // The clear is internally async (bounded retry), so poll for the terminal state.
    await pollUntil(
      () => evalInRightPanelDevtools<{ stored: string | null; box: string }>(electronApp, boxStateScript()).catch(() => ({
        stored: 'poll-error',
        box: 'poll-error',
      })),
      (state) => state.stored === null && state.box === '',
      30_000,
      200,
    )
  })
})
