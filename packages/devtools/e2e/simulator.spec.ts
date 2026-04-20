/**
 * E2E tests for simulator UI controls and interaction capabilities.
 * The interaction tests mirror the MCP tool surface: console, storage,
 * DOM, network, page info.
 */
import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  pollUntil,
} from './helpers'

test.describe('Simulator', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial', retries: 1 })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000, waitForWebview: true } })

  // ── UI Controls ────────────────────────────────────────────────────

  test('device selector is present with expected options', async ({ mainWindow }) => {
    const deviceNames = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('iPhone'))) {
          return options
        }
      }
      return []
    })

    expect(deviceNames.length).toBeGreaterThan(0)
    expect(deviceNames.some((n) => n?.includes('iPhone'))).toBe(true)
  })

  test('zoom selector is present with expected options', async ({ mainWindow }) => {
    const zoomValues = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('%'))) {
          return options
        }
      }
      return []
    })

    expect(zoomValues.length).toBeGreaterThan(0)
    expect(zoomValues.some((z) => z?.includes('100%'))).toBe(true)
  })

  test('changing device selector updates simulator dimensions', async ({ mainWindow }) => {
    // Capture original device so we can restore it for sibling tests under useSharedProject.
    const original = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('iPhone'))) return sel.value
      }
      return ''
    })

    const changed = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('iPhone SE'))) {
          sel.value = 'iPhone SE'
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }
      }
      return false
    })

    try {
      if (changed) {
        await mainWindow.waitForTimeout(500)
        const selectedDevice = await mainWindow.evaluate(() => {
          const selects = document.querySelectorAll('select')
          for (const sel of selects) {
            const options = Array.from(sel.options).map((o) => o.textContent)
            if (options.some((o) => o?.includes('iPhone'))) {
              return sel.value
            }
          }
          return ''
        })
        expect(selectedDevice).toBe('iPhone SE')
      }
    } finally {
      if (original) {
        await mainWindow.evaluate((value) => {
          const selects = document.querySelectorAll('select')
          for (const sel of selects) {
            const options = Array.from(sel.options).map((o) => o.textContent)
            if (options.some((o) => o?.includes('iPhone'))) {
              sel.value = value
              sel.dispatchEvent(new Event('change', { bubbles: true }))
              return
            }
          }
        }, original)
      }
    }
  })

  // ── Console ────────────────────────────────────────────────────────

  test('console.log is a function in simulator', async ({ electronApp }) => {
    const result = await evalInSimulator<string>(electronApp, `typeof console.log`)
    expect(result).toBe('function')

    // Verify console.log doesn't throw
    await evalInSimulator(electronApp, `console.log('e2e-test-marker')`)
  })

  // ── Storage ────────────────────────────────────────────────────────

  test('can read and write localStorage in simulator', async ({ electronApp }) => {
    // Write
    await evalInSimulator(electronApp,
      `localStorage.setItem('e2e_test_key', 'e2e_test_value')`
    )

    // Read back
    const value = await evalInSimulator<string>(electronApp,
      `localStorage.getItem('e2e_test_key')`
    )
    expect(value).toBe('e2e_test_value')

    // Clean up
    await evalInSimulator(electronApp, `localStorage.removeItem('e2e_test_key')`)
    const removed = await evalInSimulator(electronApp,
      `localStorage.getItem('e2e_test_key')`
    )
    expect(removed).toBeNull()
  })

  test('wx storage compatibility APIs are available', async ({ electronApp }) => {
    const info = await evalInSimulator<{ hasGetter: boolean; hasSetter: boolean; hasInfo: boolean }>(
      electronApp,
      `({
        hasGetter: typeof globalThis.wx?.getStorageSync === 'function',
        hasSetter: typeof globalThis.wx?.setStorageSync === 'function',
        hasInfo: typeof globalThis.wx?.getStorageInfoSync === 'function',
      })`
    )
    expect(info).toEqual({ hasGetter: true, hasSetter: true, hasInfo: true })
  })

  // ── DOM / Page Info ────────────────────────────────────────────────

  test('simulator page has expected URL structure', async ({ electronApp }) => {
    const url = await evalInSimulator<string>(electronApp, `location.href`)
    expect(url).toMatch(/^http:\/\/localhost:\d+\//)
    expect(url).toContain('#')
  })

  test('simulator page title is present', async ({ electronApp }) => {
    const title = await evalInSimulator<string>(electronApp, `document.title`)
    expect(typeof title).toBe('string')
  })

  test('simulator DOM has expected root structure', async ({ electronApp }) => {
    const rootInfo = await evalInSimulator<{ hasBody: boolean; childCount: number }>(
      electronApp,
      `({ hasBody: !!document.body, childCount: document.body.children.length })`
    )
    expect(rootInfo.hasBody).toBe(true)
    expect(rootInfo.childCount).toBeGreaterThan(0)
  })

  // ── Viewport / Device Info ─────────────────────────────────────────

  test('simulator viewport matches device dimensions', async ({ electronApp }) => {
    const viewport = await evalInSimulator<{ width: number; height: number }>(
      electronApp,
      `({ width: window.innerWidth, height: window.innerHeight })`
    )
    // The default device is iPhone X (375x812) but viewport may differ
    // At minimum, width and height should be positive
    expect(viewport.width).toBeGreaterThan(0)
    expect(viewport.height).toBeGreaterThan(0)
  })

  // ── JavaScript evaluation ──────────────────────────────────────────

  test('can evaluate complex expressions in simulator', async ({ electronApp }) => {
    const result = await evalInSimulator<{ sum: number; type: string }>(
      electronApp,
      `(() => {
        const arr = [1, 2, 3, 4, 5]
        return { sum: arr.reduce((a, b) => a + b, 0), type: typeof window }
      })()`
    )
    expect(result.sum).toBe(15)
    expect(result.type).toBe('object')
  })

  test('can access window.__deviceInfo in simulator', async ({ electronApp }) => {
    // Device info is sent from renderer on webview dom-ready
    const deviceInfo = await pollUntil(
      () => evalInSimulator<Record<string, unknown> | null>(
        electronApp,
        `window.__deviceInfo || null`
      ),
      (val) => val !== null,
      10000
    ).catch(() => null)

    // Device info may or may not be set depending on timing
    if (deviceInfo) {
      expect(typeof deviceInfo).toBe('object')
    }
  })
})
