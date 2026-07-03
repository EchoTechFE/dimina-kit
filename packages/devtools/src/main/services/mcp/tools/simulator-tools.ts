/**
 * Simulator-specific MCP tools beyond the shared set (screenshot, console,
 * evaluate, DOM, network) registered via `registerCommonTargetTools`.
 *
 * Two tools live here:
 *   - `simulator_navigate`: navigate or reload the simulator webview
 *   - `simulator_input`: unified input dispatcher (tap/type/scroll/key)
 *
 * Other simulator inspection use-cases (storage get/set, page info) are
 * handled via `simulator_evaluate` and `simulator_get_overview`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type CDP from 'chrome-remote-interface'
import { z } from 'zod'
import { getClient } from '../target-manager.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(msg: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
}

async function clickAt(c: CDP.Client, x: number, y: number): Promise<void> {
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function tapCoord(c: CDP.Client, x: number | undefined, y: number | undefined): Promise<ToolResult> {
  if (typeof x !== 'number' || typeof y !== 'number') return err('tap_coord requires x and y')
  await clickAt(c, x, y)
  return ok(`Tapped at (${x}, ${y})`)
}

/**
 * In-page expression evaluated by `tap_selector`: locates the nth match,
 * scrolls it into view, and reports its center point (or a reason it can't be
 * tapped) so the caller can dispatch a real mouse click at that point.
 */
function buildTapSelectorExpression(selector: string, index: number): string {
  return `(() => {
    const payload = ${JSON.stringify({ selector, index })}
    try {
      const matches = Array.from(document.querySelectorAll(payload.selector))
      if (matches.length === 0) {
        return { ok: false, reason: 'no_match', message: \`selector matched no elements: \${payload.selector}\` }
      }
      if (payload.index < 0 || payload.index >= matches.length) {
        return { ok: false, reason: 'out_of_range', message: \`nth \${payload.index} out of range (matches: \${matches.length})\` }
      }
      const element = matches[payload.index]
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        return { ok: false, reason: 'not_visible', message: \`selector matched an element, but it is not visible or rendered (zero rect): \${payload.selector}[\${payload.index}]\` }
      }
      return {
        ok: true,
        selector: payload.selector,
        index: payload.index,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: 'selector_error', message: \`invalid selector: \${payload.selector} (\${message})\` }
    }
  })()`
}

type TapSelectorHit = { ok: true; selector: string; index: number; x: number; y: number; rect: { left: number; top: number; width: number; height: number } }
type TapSelectorMiss = { ok: false; reason: string; message: string }

async function tapSelector(c: CDP.Client, selector: string | undefined, nth: number | undefined): Promise<ToolResult> {
  if (!selector) return err('tap_selector requires selector')
  const index = nth ?? 0
  const expression = buildTapSelectorExpression(selector, index)
  const result = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })
  const value = result.result?.value as TapSelectorHit | TapSelectorMiss | undefined
  if (!value) return err(`selector evaluation returned no result: ${selector}[${index}]`)
  if (!value.ok) return err(value.message)
  await clickAt(c, value.x, value.y)
  return ok(`Tapped selector ${value.selector}[${value.index}] at (${value.x}, ${value.y}) within rect (${value.rect.left}, ${value.rect.top}, ${value.rect.width} x ${value.rect.height})`)
}

async function typeText(
  c: CDP.Client,
  selector: string | undefined,
  nth: number | undefined,
  text: string | undefined,
): Promise<ToolResult> {
  if (!selector || typeof text !== 'string') return err('type requires selector and text')
  const { root } = await c.DOM.getDocument({ depth: 0 })
  const { nodeIds } = await c.DOM.querySelectorAll({ nodeId: root.nodeId, selector })
  if (!nodeIds || nodeIds.length === 0) return err(`selector matched no elements: ${selector}`)
  const index = nth ?? 0
  if (index < 0 || index >= nodeIds.length) return err(`nth ${index} out of range (matches: ${nodeIds.length})`)
  await c.DOM.focus({ nodeId: nodeIds[index] })
  try {
    await c.Input.insertText({ text })
  }
  catch {
    for (const ch of text) {
      await c.Input.dispatchKeyEvent({ type: 'char', text: ch })
    }
  }
  return ok(`Typed ${text.length} char(s) into ${selector}[${index}]`)
}

async function scrollAt(
  c: CDP.Client,
  x: number | undefined,
  y: number | undefined,
  deltaX: number | undefined,
  deltaY: number | undefined,
): Promise<ToolResult> {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof deltaX !== 'number' || typeof deltaY !== 'number') {
    return err('scroll requires x, y, deltaX, deltaY')
  }
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX, deltaY })
  return ok(`Scrolled at (${x}, ${y}) by (${deltaX}, ${deltaY})`)
}

async function dispatchKey(c: CDP.Client, key: string | undefined): Promise<ToolResult> {
  if (!key) return err('key requires key')
  const isSingleChar = key.length === 1
  const down: Parameters<typeof c.Input.dispatchKeyEvent>[0] = { type: 'keyDown', key, code: key }
  if (isSingleChar) down.text = key
  await c.Input.dispatchKeyEvent(down)
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: key })
  return ok(`Dispatched key ${key}`)
}

export function registerSimulatorTools(server: McpServer): void {
  server.tool('simulator_navigate', 'Navigate the simulator to a URL, or reload the current page', {
    url: z.string().optional().describe('URL to navigate to'),
    reload: z.boolean().optional().describe('If true, reload current page instead of navigating'),
  }, async ({ url, reload }) => {
    const c = getClient('simulator')
    if (reload) {
      await c.Page.reload({ ignoreCache: false })
      const note = url ? ' (url ignored because reload=true)' : ''
      return { content: [{ type: 'text' as const, text: `Reloaded simulator${note}` }] }
    }
    if (url) {
      const result = await c.Page.navigate({ url })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ frameId: result.frameId, loaderId: result.loaderId }, null, 2) }] }
    }
    return { content: [{ type: 'text' as const, text: 'Error: either url or reload is required' }], isError: true }
  })

  server.tool('simulator_input', 'Dispatch input to the simulator. `tap_coord` requires x and y. `tap_selector` requires selector and optional nth. `type` requires selector and text. `scroll` requires x, y, deltaX, and deltaY. `key` is best-effort for common keys such as Enter, Escape, Tab, Arrow* and Space.', {
    action: z.enum(['tap_coord', 'tap_selector', 'type', 'scroll', 'key']).describe('Input action to dispatch'),
    x: z.number().optional().describe('Viewport x coordinate for `tap_coord` or `scroll`'),
    y: z.number().optional().describe('Viewport y coordinate for `tap_coord` or `scroll`'),
    selector: z.string().optional().describe('CSS selector for `tap_selector` or `type`'),
    nth: z.number().int().optional().describe('Zero-based index when selector matches multiple elements; defaults to 0'),
    text: z.string().optional().describe('Text to insert for `type`'),
    key: z.string().optional().describe('Best-effort keyboard key name for `key`; common keys such as Enter, Escape, Tab, Arrow* and Space work best'),
    deltaX: z.number().optional().describe('Horizontal wheel delta for `scroll`'),
    deltaY: z.number().optional().describe('Vertical wheel delta for `scroll`'),
  }, async ({ action, x, y, selector, nth, text, key, deltaX, deltaY }) => {
    const c = getClient('simulator')
    switch (action) {
      case 'tap_coord':
        return tapCoord(c, x, y)
      case 'tap_selector':
        return tapSelector(c, selector, nth)
      case 'type':
        return typeText(c, selector, nth, text)
      case 'scroll':
        return scrollAt(c, x, y, deltaX, deltaY)
      case 'key':
        return dispatchKey(c, key)
      default:
        return err(`unknown action: ${String(action)}`)
    }
  })
}
