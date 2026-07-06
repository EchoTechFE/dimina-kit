import { describe, expect, it, vi } from 'vitest'
import { createAgentTools } from './agent-tools.js'

/** Hand-written mock shaped like ProjectFsClient's public surface. Every
 * method is a vi.fn() so tests can assert on the exact args it receives,
 * and returns a distinguishable sentinel value so tests can assert the
 * tool's execute() forwards the fs call's result untouched. */
function createMockFs() {
  return {
    read: vi.fn(async (path: string) => ({ content: `content:${path}`, rev: 1 })),
    ls: vi.fn(async () => ({ paths: ['a.txt'] })),
    glob: vi.fn(async (pattern: string) => ({ paths: [pattern] })),
    grep: vi.fn(async () => ({ hits: [] })),
    write: vi.fn(async () => ({ rev: 2 })),
    edit: vi.fn(async () => ({ rev: 3 })),
    mv: vi.fn(async () => ({ ok: true })),
    rm: vi.fn(async () => ({ ok: true })),
    checkpoint: vi.fn(async () => ({ cpId: 'cp-1' })),
    restore: vi.fn(async () => ({ ok: true })),
    diff: vi.fn(async (turnId?: string) => ({ changes: [], turnId })),
    turnBegin: vi.fn(async (_turnId: string, _opts?: Record<string, unknown>) => ({ cpId: 'cp-0', expiresAt: 1234 })),
    turnEnd: vi.fn(async () => ({ closed: true })),
  }
}

describe('createAgentTools', () => {
  it('exposes exactly the ten tools by their documented names, each with a description, inputSchema, and execute', () => {
    const { tools, byName } = createAgentTools(createMockFs())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      ['fs_checkpoint', 'fs_diff', 'fs_edit', 'fs_glob', 'fs_grep', 'fs_ls', 'fs_mv', 'fs_read', 'fs_restore', 'fs_rm', 'fs_write'].sort(),
    )
    for (const t of tools) {
      expect(byName[t.name]).toBe(t)
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.inputSchema).toBeTruthy()
      expect(typeof t.execute).toBe('function')
    }
  })

  it('marks only fs_restore as dangerous', () => {
    const { tools } = createAgentTools(createMockFs())
    for (const t of tools) {
      if (t.name === 'fs_restore') expect(t.dangerous).toBe(true)
      else expect(t.dangerous).toBeUndefined()
    }
  })

  it('mints a fresh t-<base36>-<seq> turnId on beginTurn, forwards opts to fs.turnBegin, and merges its result', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    const result = await agent.beginTurn({ reason: 'test' })
    expect(fs.turnBegin).toHaveBeenCalledTimes(1)
    const [turnIdArg, optsArg] = fs.turnBegin.mock.calls[0]!
    expect(turnIdArg).toMatch(/^t-[0-9a-z]+-\d+$/)
    expect(optsArg).toEqual({ reason: 'test' })
    expect(result.turnId).toBe(turnIdArg)
    expect(result.cpId).toBe('cp-0')
    expect(result.expiresAt).toBe(1234)
    expect(agent.activeTurn).toBe(turnIdArg)
  })

  it('returns {closed:false} without calling fs.turnEnd when there is no active turn', async () => {
    const fs = createMockFs()
    const { endTurn } = createAgentTools(fs)
    const result = await endTurn()
    expect(result).toEqual({ closed: false })
    expect(fs.turnEnd).not.toHaveBeenCalled()
  })

  it('calls fs.turnEnd with the active turnId, clears activeTurn, and returns its result when a turn is active', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    const { turnId } = await agent.beginTurn()
    const result = await agent.endTurn()
    expect(fs.turnEnd).toHaveBeenCalledExactlyOnceWith(turnId)
    expect(result).toEqual({ closed: true })
    expect(agent.activeTurn).toBeNull()
  })

  it('injects {actor:"agent", turnId:activeTurn} into fs.write, overriding any turnId the caller tries to pass', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    const { turnId } = await agent.beginTurn()
    await agent.byName.fs_write!.execute({ path: 'a.txt', content: 'hi', turnId: 'forged-turn' })
    expect(fs.write).toHaveBeenCalledExactlyOnceWith('a.txt', 'hi', { actor: 'agent', turnId, ifMatch: undefined })
  })

  it('injects actor/turnId into every other write tool (edit, mv, rm, checkpoint, restore)', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    const { turnId } = await agent.beginTurn()

    await agent.byName.fs_edit!.execute({ path: 'a.txt', old: 'x', next: 'y' })
    expect(fs.edit).toHaveBeenCalledExactlyOnceWith('a.txt', 'x', 'y', { actor: 'agent', turnId })

    await agent.byName.fs_mv!.execute({ from: 'a.txt', to: 'b.txt' })
    expect(fs.mv).toHaveBeenCalledExactlyOnceWith('a.txt', 'b.txt', { actor: 'agent', turnId })

    await agent.byName.fs_rm!.execute({ path: 'a.txt' })
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith('a.txt', { actor: 'agent', turnId })

    await agent.byName.fs_checkpoint!.execute({})
    expect(fs.checkpoint).toHaveBeenCalledExactlyOnceWith({ actor: 'agent', turnId })

    await agent.byName.fs_restore!.execute({ cpId: 'cp-1', force: true })
    expect(fs.restore).toHaveBeenCalledExactlyOnceWith('cp-1', { actor: 'agent', turnId, force: true })
  })

  it('injects turnId:null (no actor forgery possible) when a write tool is invoked with no active turn', async () => {
    const fs = createMockFs()
    const { byName } = createAgentTools(fs)
    await byName.fs_write!.execute({ path: 'a.txt', content: 'hi' })
    expect(fs.write).toHaveBeenCalledExactlyOnceWith('a.txt', 'hi', { actor: 'agent', turnId: null, ifMatch: undefined })
  })

  it('forwards read tool args to fs without injecting actor or turnId', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    await agent.beginTurn()

    await agent.byName.fs_read!.execute({ path: 'a.txt' })
    expect(fs.read).toHaveBeenCalledExactlyOnceWith('a.txt')

    await agent.byName.fs_ls!.execute({})
    expect(fs.ls).toHaveBeenCalledExactlyOnceWith()

    await agent.byName.fs_glob!.execute({ pattern: '*.ts' })
    expect(fs.glob).toHaveBeenCalledExactlyOnceWith('*.ts')

    await agent.byName.fs_grep!.execute({ pattern: 'foo', glob: '*.ts', limit: 5 })
    expect(fs.grep).toHaveBeenCalledExactlyOnceWith('foo', { glob: '*.ts', limit: 5 })
  })

  it('defaults fs_diff turnId to activeTurn when no turnId argument is passed', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    const { turnId } = await agent.beginTurn()
    await agent.byName.fs_diff!.execute()
    expect(fs.diff).toHaveBeenCalledExactlyOnceWith(turnId)
  })

  it('lets fs_diff use an explicitly passed turnId instead of activeTurn', async () => {
    const fs = createMockFs()
    const agent = createAgentTools(fs)
    await agent.beginTurn()
    await agent.byName.fs_diff!.execute({ turnId: 'other-turn' })
    expect(fs.diff).toHaveBeenCalledExactlyOnceWith('other-turn')
  })
})
