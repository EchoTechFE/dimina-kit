/**
 * Type-consumption smoke check: guards that the package.json `exports` map
 * resolves `types` for all four public subpaths (not just `default`).
 * Not a runtime test — only needs to satisfy `tsc --noEmit`.
 */
import type { ProjectFsClient } from '@dimina-kit/fs-core/client'
import type {
  FsCheckpointOpts, FsRestoreOpts, FsTurnBeginOpts, FsWriteCallOpts,
} from '@dimina-kit/fs-core/client'
import type { AgentTool, AgentToolsFs } from '@dimina-kit/fs-core/agent-tools'
import { createAgentTools } from '@dimina-kit/fs-core/agent-tools'
import type { DiskMirrorFs } from '@dimina-kit/fs-core/disk-mirror'
import { createDiskMirror } from '@dimina-kit/fs-core/disk-mirror'
import { makeZip } from '@dimina-kit/fs-core/zip'

export function typesSmoke(client: ProjectFsClient, fs: AgentToolsFs & DiskMirrorFs): {
  tool: AgentTool | undefined
  zip: Uint8Array
  mirrorActive: boolean
} {
  const agent = createAgentTools(fs)
  const mirror = createDiskMirror(fs)
  const zip = makeZip({ 'a.txt': 'hello' })
  void client.projectId
  return { tool: agent.byName.fs_read, zip, mirrorActive: mirror.active }
}

// ── Write-API contract smoke: client write methods must carry their real
// worker-side opts/result shapes end to end, not the current `Record<string,
// unknown> → Promise<unknown>` erasure (src/client.ts:200-232). Guards that
// FsWriteCallOpts/FsCheckpointOpts/FsRestoreOpts/FsTurnBeginOpts and their
// matching result types are exported from `/client` and threaded onto every
// write method's signature. Not a runtime test — `tsc --noEmit` only.
export async function fsWriteContractSmoke(client: ProjectFsClient): Promise<void> {
  // 1) write()'s result carries {gen, rev} — `Promise<unknown>` cannot be
  // assigned here, so this line only compiles once the return type is real.
  const written: { gen: number; rev: number } = await client.write('a', 'b')
  void written

  // 2) every FsWriteCallOpts field is accepted by write()'s third param.
  const fullOpts: FsWriteCallOpts = { actor: 'agent', turnId: 't', agentToken: 'x', ifMatch: 3 }
  void client.write('a', 'b', fullOpts)

  // 3) checkpoint/turnBegin/turnEnd expose their op-specific extra fields.
  const cp = await client.checkpoint()
  const cpId: string = cp.cpId
  const turn = await client.turnBegin('t', { ttlMs: 1 })
  const expiresAt: number = turn.expiresAt
  const ended = await client.turnEnd('t')
  const closed: boolean = ended.closed
  void [cpId, expiresAt, closed]

  // restore()/checkpoint() share the {actor,turnId,agentToken} shape by
  // construction (FsRestoreOpts extends FsCheckpointOpts).
  const restoreOpts: FsRestoreOpts = { baseGen: 1, force: true, actor: 'human' }
  const checkpointOpts: FsCheckpointOpts = restoreOpts
  void checkpointOpts
  const beginOpts: FsTurnBeginOpts = { ttlMs: 500 }
  void beginOpts
}

// ── Reverse guards: opts objects that violate the contract must NOT
// type-check against it. Expressed as an "assign to never on regression"
// trick (no @ts-expect-error — that counts as a type-escape under this
// repo's ratchet): `Assignable<Bad, Good>` is `false` today, so `Guard`
// below is `true` and the `const` assignment is inert; if a future change
// widens FsWriteCallOpts enough that `Bad` becomes assignable, `Guard`
// collapses to `never` and this file stops compiling.
type Assignable<T, U> = [T] extends [U] ? true : false
type RejectsBadActorLiteral = Assignable<{ actor: 'robot' }, FsWriteCallOpts> extends false ? true : never
const _guardRejectsBadActorLiteral: RejectsBadActorLiteral = true
void _guardRejectsBadActorLiteral

// A misspelled key (`turnid` instead of `turnId`) is an excess-property
// error, which TS only raises for a *fresh* object literal in assignment/
// call position — not through a structural `extends` check like the one
// above (every FsWriteCallOpts field is optional, so `{ turnid: 'x' }`
// structurally satisfies it once the mismatched key is erased by widening).
// Expressing "this typo must be rejected" as a standing assertion would
// therefore need either @ts-expect-error (banned by the ratchet) or a
// direct literal assignment that hard-fails compilation forever (defeats
// the point of a check file meant to go green). Left unexpressed here;
// verified manually instead — see below.
//   const _typoRejected: FsWriteCallOpts = { turnid: 'x' } // <- real tsc error today: "'turnid' does not exist in type 'FsWriteCallOpts'"
