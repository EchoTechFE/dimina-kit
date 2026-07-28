import { describe, expect, it, vi } from 'vitest'
import { registerWorkbenchTools } from './workbench-tools.js'

vi.mock('../target-manager.js', () => ({
  listTargets: vi.fn(),
}))

import { listTargets } from '../target-manager.js'

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
  } as unknown as Parameters<typeof registerWorkbenchTools>[0]
  registerWorkbenchTools(server)
  function call(name: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`tool not registered: ${name}`)
    return handler(args)
  }
  return { handlers, call }
}

describe('workbench_list_targets', () => {
  it('returns formatted target list with id, type, title, url', async () => {
    vi.mocked(listTargets).mockResolvedValue([
      { id: 't1', type: 'page', title: 'Main', url: 'https://localhost/main', webSocketDebuggerUrl: 'ws://...' },
      { id: 't2', type: 'webview', title: 'Sim', url: 'https://localhost:7788', webSocketDebuggerUrl: 'ws://...' },
    ] as Awaited<ReturnType<typeof listTargets>>)
    const { call } = captureTools()

    const result = await call('workbench_list_targets')
    const targets = JSON.parse(result.content[0]!.text)

    expect(targets).toHaveLength(2)
    expect(targets[0]).toEqual({ id: 't1', type: 'page', title: 'Main', url: 'https://localhost/main' })
    expect(targets[1]).toEqual({ id: 't2', type: 'webview', title: 'Sim', url: 'https://localhost:7788' })
    // Extra fields like webSocketDebuggerUrl are stripped
    expect(targets[0]).not.toHaveProperty('webSocketDebuggerUrl')
  })
})
