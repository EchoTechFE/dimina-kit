/**
 * Guards per-project isolation of the forced page-frame Referer.
 *
 * Each open project runs on its own session partition (see
 * ../views/miniapp-partition.ts); the Referer this module hands to
 * `onBeforeSendHeaders` must be scoped to that partition. A module-level
 * single value would let the most-recently-opened project's Referer leak
 * onto every other concurrently open project's requests, and let any
 * project's close/failed-compile clear every other project's Referer too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// miniapp-partition.ts (imported transitively to derive the partition key)
// touches `electron` at module load — stub it so this stays a pure unit test.
vi.mock('electron', () => ({
  session: { fromPartition: (_p: string) => ({}) },
}))

import {
  buildServicewechatPageFrameReferer,
  clearSimulatorServicewechatReferer,
  getSimulatorServicewechatReferer,
  setSimulatorServicewechatReferer,
} from './referer.js'
import { miniappPartition } from '../views/miniapp-partition.js'

const PROJECT_A = { appId: 'wxa1111111111111', path: '/projects/a' }
const PROJECT_B = { appId: 'wxb2222222222222', path: '/projects/b' }

beforeEach(() => {
  // Drain whatever the previous test left behind so partitions never leak
  // across cases.
  clearSimulatorServicewechatReferer(PROJECT_A.appId, PROJECT_A.path)
  clearSimulatorServicewechatReferer(PROJECT_B.appId, PROJECT_B.path)
})

describe('per-project Referer isolation', () => {
  it('two concurrently open projects each keep their own Referer', () => {
    setSimulatorServicewechatReferer(PROJECT_A.appId, undefined, PROJECT_A.path)
    setSimulatorServicewechatReferer(PROJECT_B.appId, undefined, PROJECT_B.path)

    const partitionA = miniappPartition(PROJECT_A.appId, PROJECT_A.path)
    const partitionB = miniappPartition(PROJECT_B.appId, PROJECT_B.path)

    // If project B's set() clobbered a shared slot, A's Referer would read
    // back as B's appId — this is the user-visible cross-contamination bug.
    expect(getSimulatorServicewechatReferer(partitionA)).toBe(
      buildServicewechatPageFrameReferer(PROJECT_A.appId),
    )
    expect(getSimulatorServicewechatReferer(partitionB)).toBe(
      buildServicewechatPageFrameReferer(PROJECT_B.appId),
    )
  })

  it('clearing project A does not clear project B (still-open project keeps its Referer)', () => {
    setSimulatorServicewechatReferer(PROJECT_A.appId, undefined, PROJECT_A.path)
    setSimulatorServicewechatReferer(PROJECT_B.appId, undefined, PROJECT_B.path)

    clearSimulatorServicewechatReferer(PROJECT_A.appId, PROJECT_A.path)

    const partitionA = miniappPartition(PROJECT_A.appId, PROJECT_A.path)
    const partitionB = miniappPartition(PROJECT_B.appId, PROJECT_B.path)

    // A user closing (or failing to compile) one project must never strip the
    // forced Referer off another project that is still running.
    expect(getSimulatorServicewechatReferer(partitionA)).toBeNull()
    expect(getSimulatorServicewechatReferer(partitionB)).toBe(
      buildServicewechatPageFrameReferer(PROJECT_B.appId),
    )
  })

  it('clearing without an appId is a no-op (nothing to target, not a global wipe)', () => {
    setSimulatorServicewechatReferer(PROJECT_A.appId, undefined, PROJECT_A.path)

    // A caller that reaches clear() before it ever learned an appId (e.g. a
    // failed compile before appInfo resolves) has no partition to target —
    // it must not fall back to nuking every open project's Referer.
    clearSimulatorServicewechatReferer()

    const partitionA = miniappPartition(PROJECT_A.appId, PROJECT_A.path)
    expect(getSimulatorServicewechatReferer(partitionA)).toBe(
      buildServicewechatPageFrameReferer(PROJECT_A.appId),
    )
  })
})
