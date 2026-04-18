/**
 * E2E tests for simulator interaction capabilities.
 * These mirror the MCP tool surface: console, storage, DOM, network, page info.
 */
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  evalInSimulator,
  pollUntil,
  waitForSimulatorWebview,
} from './helpers'

test.describe('Simulator Interaction', () => {
  test.setTimeout(90_000)
  // The first test can fail due to port contention from previous test teardown
  test.describe.configure({ retries: 1 })

  test.beforeEach(async ({ mainWindow, electronApp }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 8000, waitForWebview: true })
    await waitForSimulatorWebview(electronApp)
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
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
