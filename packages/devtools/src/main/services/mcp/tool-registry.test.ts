import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCommonTargetTools } from './tool-registry.js'
import { getTargetState, type ConsoleLogEntry, type NetworkRequestEntry, type TargetKind } from './target-manager.js'

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>
type Client = NonNullable<ReturnType<typeof getTargetState>['client']>
type DomRoot = Awaited<ReturnType<Client['DOM']['getDocument']>>['root']

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

function createDomRoot(overrides: Partial<DomRoot> = {}): DomRoot {
  return {
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    nodeValue: '',
    ...overrides,
  }
}

function captureTools(kind: TargetKind) {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as Parameters<typeof registerCommonTargetTools>[0]
  registerCommonTargetTools(server, kind)
  function call(name: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`tool not registered: ${name}`)
    return handler(args)
  }
  return { handlers, call }
}

function injectClient(kind: TargetKind) {
  const state = getTargetState(kind)
  state.connected = true
  state.client = {
    Page: { captureScreenshot: vi.fn() },
    Runtime: { evaluate: vi.fn() },
    DOM: { getDocument: vi.fn() },
  } as unknown as typeof state.client
  state.consoleLogs = []
  state.networkRequests = []
  return state
}

function resetState(kind: TargetKind) {
  const state = getTargetState(kind)
  state.connected = false
  state.client = null
  state.consoleLogs = []
  state.networkRequests = []
}

describe('registerCommonTargetTools — simulator', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('registers 5 tools for simulator (including evaluate)', () => {
    const { handlers } = captureTools('simulator')
    expect(handlers.has('simulator_screenshot')).toBe(true)
    expect(handlers.has('simulator_console_logs')).toBe(true)
    expect(handlers.has('simulator_evaluate')).toBe(true)
    expect(handlers.has('simulator_get_dom')).toBe(true)
    expect(handlers.has('simulator_network_log')).toBe(true)
    expect(handlers.size).toBe(5)
  })
})

describe('registerCommonTargetTools — workbench', () => {
  beforeEach(() => injectClient('workbench'))
  afterEach(() => resetState('workbench'))

  it('registers 4 tools for workbench (evaluate excluded for security)', () => {
    const { handlers } = captureTools('workbench')
    expect(handlers.has('workbench_screenshot')).toBe(true)
    expect(handlers.has('workbench_console_logs')).toBe(true)
    expect(handlers.has('workbench_evaluate')).toBe(false)
    expect(handlers.has('workbench_get_dom')).toBe(true)
    expect(handlers.has('workbench_network_log')).toBe(true)
    expect(handlers.size).toBe(4)
  })
})

describe('screenshot', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('calls Page.captureScreenshot and returns image content', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Page.captureScreenshot).mockResolvedValue({ data: 'base64png' })
    const { call } = captureTools('simulator')

    const result = await call('simulator_screenshot')

    expect(state.client!.Page.captureScreenshot).toHaveBeenCalledWith({ format: 'png' })
    expect(result.content[0]).toEqual({ type: 'image', data: 'base64png', mimeType: 'image/png' })
  })
})

describe('console_logs', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('returns all logs when no filters applied', async () => {
    const state = getTargetState('simulator')
    state.consoleLogs = [
      { level: 'log', text: 'hello', timestamp: '2025-01-01T00:00:00.000Z' },
      { level: 'error', text: 'boom', timestamp: '2025-01-01T00:00:01.000Z' },
    ]
    const { call } = captureTools('simulator')

    const result = await call('simulator_console_logs', { limit: 50 })
    const entries = parseJson<ConsoleLogEntry[]>(result.content[0]!.text!)
    expect(entries).toHaveLength(2)
  })

  it('filters by level, treating warn and warning as aliases', async () => {
    const state = getTargetState('simulator')
    state.consoleLogs = [
      { level: 'warning', text: 'w1', timestamp: '2025-01-01T00:00:00.000Z' },
      { level: 'warn', text: 'w2', timestamp: '2025-01-01T00:00:01.000Z' },
      { level: 'error', text: 'e1', timestamp: '2025-01-01T00:00:02.000Z' },
    ]
    const { call } = captureTools('simulator')

    const byWarning = parseJson<ConsoleLogEntry[]>(
      (await call('simulator_console_logs', { limit: 50, level: 'warning' })).content[0]!.text!,
    )
    expect(byWarning).toHaveLength(2)
    expect(byWarning.map((e) => e.text)).toEqual(['w1', 'w2'])

    const byWarn = parseJson<ConsoleLogEntry[]>(
      (await call('simulator_console_logs', { limit: 50, level: 'warn' })).content[0]!.text!,
    )
    expect(byWarn).toHaveLength(2)
  })

  it('filters by sinceTimestamp', async () => {
    const state = getTargetState('simulator')
    state.consoleLogs = [
      { level: 'log', text: 'old', timestamp: '2025-01-01T00:00:00.000Z' },
      { level: 'log', text: 'new', timestamp: '2025-01-01T00:00:02.000Z' },
    ]
    const { call } = captureTools('simulator')

    const entries = parseJson<ConsoleLogEntry[]>(
      (await call('simulator_console_logs', { limit: 50, sinceTimestamp: '2025-01-01T00:00:01.000Z' })).content[0]!.text!,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('new')
  })

  it('truncates to limit (takes last N entries)', async () => {
    const state = getTargetState('simulator')
    state.consoleLogs = Array.from({ length: 10 }, (_, i) => ({
      level: 'log', text: `msg${i}`, timestamp: `2025-01-01T00:00:0${i}.000Z`,
    }))
    const { call } = captureTools('simulator')

    const entries = parseJson<ConsoleLogEntry[]>((await call('simulator_console_logs', { limit: 3 })).content[0]!.text!)
    expect(entries).toHaveLength(3)
    expect(entries[0].text).toBe('msg7')
  })
})

describe('evaluate', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('calls Runtime.evaluate and returns the value', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { value: 42, type: 'number' },
    })
    const { call } = captureTools('simulator')

    const result = await call('simulator_evaluate', { expression: '1+1' })
    expect(state.client!.Runtime.evaluate).toHaveBeenCalledWith({
      expression: '1+1', returnByValue: true, awaitPromise: true,
    })
    expect(JSON.parse(result.content[0]!.text!)).toBe(42)
  })

  it('returns isError when exceptionDetails is present', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { type: 'undefined' },
      exceptionDetails: {
        exceptionId: 1,
        text: 'ReferenceError: x is not defined',
        lineNumber: 0,
        columnNumber: 0,
      },
    })
    const { call } = captureTools('simulator')

    const result = await call('simulator_evaluate', { expression: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('ReferenceError')
  })

  it('falls back to description or type when value is undefined', async () => {
    const state = getTargetState('simulator')
    vi.mocked(state.client!.Runtime.evaluate).mockResolvedValue({
      result: { type: 'object', description: 'HTMLDivElement' },
    })
    const { call } = captureTools('simulator')

    const result = await call('simulator_evaluate', { expression: 'document.body' })
    expect(JSON.parse(result.content[0]!.text!)).toBe('HTMLDivElement')
  })
})

describe('get_dom', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('calls DOM.getDocument with the provided depth', async () => {
    const fakeRoot = createDomRoot({ nodeName: 'html', localName: 'html' })
    const state = getTargetState('simulator')
    vi.mocked(state.client!.DOM.getDocument).mockResolvedValue({ root: fakeRoot })
    const { call } = captureTools('simulator')

    const result = await call('simulator_get_dom', { depth: 5 })
    expect(state.client!.DOM.getDocument).toHaveBeenCalledWith({ depth: 5 })
    expect(parseJson<DomRoot>(result.content[0]!.text!)).toEqual(fakeRoot)
  })
})

describe('network_log', () => {
  beforeEach(() => injectClient('simulator'))
  afterEach(() => resetState('simulator'))

  it('returns all network entries when no filter', async () => {
    const state = getTargetState('simulator')
    state.networkRequests = [
      { url: '/api/a', method: 'GET', status: 200, mimeType: 'application/json', responseSize: 100, timing: null },
      { url: '/api/b', method: 'POST', status: 500, mimeType: 'text/plain', responseSize: 0, timing: null },
    ]
    const { call } = captureTools('simulator')

    const entries = parseJson<NetworkRequestEntry[]>((await call('simulator_network_log', { limit: 20 })).content[0]!.text!)
    expect(entries).toHaveLength(2)
  })

  it('filters by minStatus and includes status=0 (failed) when minStatus >= 400', async () => {
    const state = getTargetState('simulator')
    state.networkRequests = [
      { url: '/ok', method: 'GET', status: 200, mimeType: '', responseSize: 0, timing: null },
      { url: '/err', method: 'GET', status: 500, mimeType: '', responseSize: 0, timing: null },
      { url: '/failed', method: 'GET', status: 0, mimeType: '', responseSize: 0, timing: null },
    ]
    const { call } = captureTools('simulator')

    const entries = parseJson<NetworkRequestEntry[]>(
      (await call('simulator_network_log', { limit: 20, minStatus: 400 })).content[0]!.text!,
    )
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.url)).toEqual(['/err', '/failed'])
  })

  it('excludes status=0 when minStatus < 400', async () => {
    const state = getTargetState('simulator')
    state.networkRequests = [
      { url: '/ok', method: 'GET', status: 200, mimeType: '', responseSize: 0, timing: null },
      { url: '/failed', method: 'GET', status: 0, mimeType: '', responseSize: 0, timing: null },
    ]
    const { call } = captureTools('simulator')

    const entries = parseJson<NetworkRequestEntry[]>(
      (await call('simulator_network_log', { limit: 20, minStatus: 200 })).content[0]!.text!,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].url).toBe('/ok')
  })

  it('truncates to limit (takes last N entries)', async () => {
    const state = getTargetState('simulator')
    state.networkRequests = Array.from({ length: 10 }, (_, i) => ({
      url: `/api/${i}`, method: 'GET', status: 200, mimeType: '', responseSize: 0, timing: null,
    }))
    const { call } = captureTools('simulator')

    const entries = parseJson<NetworkRequestEntry[]>((await call('simulator_network_log', { limit: 3 })).content[0]!.text!)
    expect(entries).toHaveLength(3)
    expect(entries[0].url).toBe('/api/7')
  })
})

describe('disconnected target', () => {
  afterEach(() => resetState('simulator'))

  it('throws when getClient is called on a disconnected target', async () => {
    const { call } = captureTools('simulator')
    await expect(call('simulator_screenshot')).rejects.toThrow('未连接到模拟器')
  })
})
