/**
 * Type-consumption smoke check: guards that the package.json `exports` map
 * resolves `types` for all four public subpaths (not just `default`).
 * Not a runtime test — only needs to satisfy `tsc --noEmit`.
 */
import type { ProjectFsClient } from '@dimina-kit/fs-core/client'
import type { AgentTool } from '@dimina-kit/fs-core/agent-tools'
import { createAgentTools } from '@dimina-kit/fs-core/agent-tools'
import { createDiskMirror } from '@dimina-kit/fs-core/disk-mirror'
import { makeZip } from '@dimina-kit/fs-core/zip'

export function typesSmoke(client: ProjectFsClient, fs: unknown): {
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
