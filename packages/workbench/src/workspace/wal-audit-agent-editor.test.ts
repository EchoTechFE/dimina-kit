/**
 * Guards the turn-door's editor propagation: `agentWrite`/`agentRm`/`rollback`
 * land on disk through the `/__fs` bridge AND push the same change into the
 * live editor buffer through the `applyToEditor` seam (the one the sync
 * engine's inbound path already uses) — an agent edit must not leave an
 * already-open buffer showing pre-agent content. Editor refresh is
 * best-effort: a failing `applyToEditor` never fails the agent operation
 * (disk and ledger are already consistent by then).
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from './types.js'
import type { WalAuditBridge, WalAuditClientLike } from './wal-audit.js'
import { walAuditSource } from './wal-audit.js'

type FileServiceArg = Parameters<WorkspaceSource['populate']>[0]

const enc = (s: string) => new TextEncoder().encode(s)

function makeBase(): WorkspaceSource {
  return {
    folderUri: 'file:///workspace',
    populate: vi.fn().mockResolvedValue(0),
  }
}

/** Bridge double over an empty disk — readdir lists nothing (so populate's
 * walk and warm-up see an empty tree), write/delete just record. */
function makeBridge(): WalAuditBridge {
  return {
    readdir: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { status: 404 })),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

/** In-memory ledger double: write/rm/read/ls back a Map; the turn surface is
 * pass-through (turn ENFORCEMENT is fs-core's own, not under test here). */
function makeLedgerClient(initial: Record<string, string> = {}): WalAuditClientLike & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    write: vi.fn(async (p: string, c: string) => {
      files.set(p, c)
    }),
    rm: vi.fn(async (p: string) => {
      files.delete(p)
    }),
    read: vi.fn(async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw Object.assign(new Error(p), { code: 'not-found' })
      return { content }
    }),
    ls: vi.fn(async () => ({ paths: [...files.keys()] })),
    restore: vi.fn().mockResolvedValue(undefined),
    turnBegin: vi.fn().mockResolvedValue(undefined),
    turnEnd: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue({ changes: [], cpId: 'cp-1' }),
    status: vi.fn().mockResolvedValue({ mode: 'writer', walGen: 1, epoch: 1 }),
    destroy: vi.fn(),
  }
}

async function makeAudited(client: WalAuditClientLike, bridge: WalAuditBridge, applyToEditor: (rel: string, content: Uint8Array | null) => Promise<void>) {
  const source = walAuditSource(makeBase(), {
    fsBaseUrl: 'http://coi.test/',
    createClient: async () => client,
    bridge,
    watchEvents: () => () => {},
    applyToEditor,
  })
  await source.populate(undefined as unknown as FileServiceArg)
  return source
}

describe('walAuditSource — turn-door editor propagation', () => {
  it('agentWrite pushes the written bytes into the editor after the bridge write', async () => {
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge()
    const source = await makeAudited(makeLedgerClient(), bridge, applyToEditor)
    await source.audit.agentWrite('src/app.js', 'agent content', 't-1')
    expect(bridge.write).toHaveBeenCalledWith('http://coi.test/', 'src/app.js', enc('agent content'))
    expect(applyToEditor).toHaveBeenCalledWith('src/app.js', enc('agent content'))
  })

  it('agentRm pushes the deletion (null) into the editor after the bridge delete', async () => {
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge()
    const source = await makeAudited(makeLedgerClient({ 'src/app.js': 'old' }), bridge, applyToEditor)
    await source.audit.agentRm('src/app.js', 't-1')
    expect(bridge.delete).toHaveBeenCalledWith('http://coi.test/', 'src/app.js')
    expect(applyToEditor).toHaveBeenCalledWith('src/app.js', null)
  })

  it('agentWrite does NOT touch the editor when the bridge write fails (compensated, error propagates)', async () => {
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge()
    ;(bridge.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('413 payload too large'))
    const source = await makeAudited(makeLedgerClient(), bridge, applyToEditor)
    await expect(source.audit.agentWrite('src/app.js', 'x', 't-1')).rejects.toThrow('413')
    expect(applyToEditor).not.toHaveBeenCalled()
  })

  it('a failing applyToEditor never fails the agent operation (disk+ledger already consistent)', async () => {
    const applyToEditor = vi.fn().mockRejectedValue(new Error('editor exploded'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = makeLedgerClient()
      const source = await makeAudited(client, makeBridge(), applyToEditor)
      await expect(source.audit.agentWrite('src/app.js', 'x', 't-1')).resolves.toBeUndefined()
      expect(client.files.get('src/app.js')).toBe('x')
    } finally {
      warn.mockRestore()
    }
  })

  it('rollback replays restored content and deletions into the editor', async () => {
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge()
    const client = makeLedgerClient()
    // The turn touched kept.js (content change, restored by ledger restore)
    // and created ghost.js (absent again after restore → disk delete).
    client.diff = vi.fn().mockResolvedValue({
      cpId: 'cp-1',
      changes: [{ path: 'kept.js' }, { path: 'ghost.js' }],
    })
    const source = await makeAudited(client, bridge, applyToEditor)
    // Seed AFTER populate: populateLedger reconciles the ledger against the
    // (empty) disk walk and would sweep a pre-seeded record as residue.
    client.files.set('kept.js', 'restored content')
    await source.audit.rollback('t-1')
    expect(bridge.write).toHaveBeenCalledWith('http://coi.test/', 'kept.js', enc('restored content'))
    expect(applyToEditor).toHaveBeenCalledWith('kept.js', enc('restored content'))
    expect(bridge.delete).toHaveBeenCalledWith('http://coi.test/', 'ghost.js')
    expect(applyToEditor).toHaveBeenCalledWith('ghost.js', null)
  })
})
