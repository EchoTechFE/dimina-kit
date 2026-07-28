import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSimulatorTools } from './simulator-tools.js'
import { getTargetState } from '../target-manager.js'

type ToolResult = {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

function captureTools() {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as Parameters<typeof registerSimulatorTools>[0]
  registerSimulatorTools(server)
  function call(name: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`tool not registered: ${name}`)
    return handler(args)
  }
  return { handlers, call }
}

function injectClient() {
  const state = getTargetState('simulator')
  state.connected = true
  state.client = {
    Page: {
      reload: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue({ frameId: 'f1', loaderId: 'l1' }),
    },
    Runtime: { evaluate: vi.fn() },
    DOM: {
      getDocument: vi.fn(),
      querySelectorAll: vi.fn(),
      focus: vi.fn().mockResolvedValue(undefined),
    },
    Input: {
      dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
      dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      insertText: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof state.client
  state.consoleLogs = []
  state.networkRequests = []
  return state
}

function resetState() {
  const state = getTargetState('simulator')
  state.connected = false
  state.client = null
  state.consoleLogs = []
  state.networkRequests = []
}

describe('simulator_navigate', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('reloads the page when reload=true', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    const result = await call('simulator_navigate', { reload: true })
    expect(state.client!.Page.reload).toHaveBeenCalledWith({ ignoreCache: false })
    expect(result.content[0]!.text).toContain('Reloaded simulator')
  })

  it('appends a note when reload=true and url is also provided', async () => {
    const { call } = captureTools()

    const result = await call('simulator_navigate', { reload: true, url: 'https://example.com' })
    expect(result.content[0]!.text).toContain('url ignored because reload=true')
  })

  it('navigates to the given url', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    const result = await call('simulator_navigate', { url: 'https://example.com' })
    expect(state.client!.Page.navigate).toHaveBeenCalledWith({ url: 'https://example.com' })
    const parsed = JSON.parse(result.content[0]!.text)
    expect(parsed).toMatchObject({ frameId: 'f1', loaderId: 'l1' })
  })

  it('returns isError when neither url nor reload is provided', async () => {
    const { call } = captureTools()

    const result = await call('simulator_navigate', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('either url or reload is required')
  })
})

describe('simulator_input — tap_coord', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('dispatches mousePressed and mouseReleased at the given coordinates', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_coord', x: 100, y: 200 })
    expect(result.content[0]!.text).toContain('Tapped at (100, 200)')
    expect(state.client!.Input.dispatchMouseEvent).toHaveBeenCalledTimes(2)
  })

  it('returns isError when x or y is missing', async () => {
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_coord', x: 100 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('tap_coord requires x and y')
  })
})

describe('simulator_input — tap_selector', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('taps the element matched by selector', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: {
        value: {
          ok: true, selector: '.btn', index: 0,
          x: 50, y: 60, rect: { left: 25, top: 35, width: 50, height: 50 },
        },
      },
    })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_selector', selector: '.btn' })
    expect(result.content[0]!.text).toContain('Tapped selector .btn[0]')
    expect(state.client!.Input.dispatchMouseEvent).toHaveBeenCalledTimes(2)
  })

  it('returns isError for no_match', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { value: { ok: false, reason: 'no_match', message: 'selector matched no elements: .missing' } },
    })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_selector', selector: '.missing' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('no elements')
  })

  it('returns isError for out_of_range', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { value: { ok: false, reason: 'out_of_range', message: 'nth 5 out of range (matches: 2)' } },
    })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_selector', selector: '.btn', nth: 5 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('out of range')
  })

  it('returns isError for not_visible', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { value: { ok: false, reason: 'not_visible', message: 'not visible or rendered (zero rect)' } },
    })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_selector', selector: '.hidden' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('not visible')
  })

  it('returns isError for selector_error', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { value: { ok: false, reason: 'selector_error', message: 'invalid selector: [[[' } },
    })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'tap_selector', selector: '[[[' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('invalid selector')
  })
})

describe('simulator_input — type', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('focuses the element and inserts text via insertText', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.DOM.getDocument).mockResolvedValue({ root: { nodeId: 1 } })
    vi.mocked(state.client!.DOM.querySelectorAll).mockResolvedValue({ nodeIds: [10] })
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'type', selector: 'input', text: 'hello' })
    expect(result.content[0]!.text).toContain('Typed 5 char(s)')
    expect(state.client!.DOM.focus).toHaveBeenCalledWith({ nodeId: 10 })
    expect(state.client!.Input.insertText).toHaveBeenCalledWith({ text: 'hello' })
  })

  it('falls back to per-character dispatchKeyEvent when insertText throws', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.DOM.getDocument).mockResolvedValue({ root: { nodeId: 1 } })
    vi.mocked(state.client!.DOM.querySelectorAll).mockResolvedValue({ nodeIds: [10] })
    vi.mocked(state.client!.Input.insertText).mockRejectedValue(new Error('not supported'))
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'type', selector: 'input', text: 'ab' })
    expect(result.content[0]!.text).toContain('Typed 2 char(s)')
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledTimes(2)
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledWith({ type: 'char', text: 'a' })
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledWith({ type: 'char', text: 'b' })
  })

  it('returns isError when selector or text is missing', async () => {
    const { call } = captureTools()

    const noSelector = await call('simulator_input', { action: 'type', text: 'hi' })
    expect(noSelector.isError).toBe(true)

    const noText = await call('simulator_input', { action: 'type', selector: 'input' })
    expect(noText.isError).toBe(true)
  })
})

describe('simulator_input — scroll', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('dispatches a mouseWheel event with the given deltas', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'scroll', x: 100, y: 200, deltaX: 0, deltaY: -100 })
    expect(result.content[0]!.text).toContain('Scrolled at (100, 200)')
    expect(state.client!.Input.dispatchMouseEvent).toHaveBeenCalledWith({
      type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -100,
    })
  })

  it('returns isError when any scroll parameter is missing', async () => {
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'scroll', x: 100, y: 200 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('scroll requires x, y, deltaX, deltaY')
  })
})

describe('simulator_input — key', () => {
  beforeEach(() => injectClient())
  afterEach(() => resetState())

  it('dispatches keyDown with text for a single character', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'key', key: 'a' })
    expect(result.content[0]!.text).toContain('Dispatched key a')
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyDown', key: 'a', text: 'a' }),
    )
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyUp', key: 'a' }),
    )
  })

  it('dispatches keyDown without text for multi-character key names', async () => {
    const state = getTargetState('simulator')
    const { call } = captureTools()

    await call('simulator_input', { action: 'key', key: 'Enter' })
    expect(state.client!.Input.dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyDown', key: 'Enter' }),
    )
    const downCall = vi.mocked(state.client!.Input.dispatchKeyEvent).mock.calls[0]![0]
    expect(downCall).not.toHaveProperty('text')
  })

  it('returns isError when key is missing', async () => {
    const { call } = captureTools()

    const result = await call('simulator_input', { action: 'key' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('key requires key')
  })
})
