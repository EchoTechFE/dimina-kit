/**
 * Per-project session partition for the native-host miniapp runtime (P0 debt).
 *
 * Historically every project's miniapp webContents — the simulator content
 * WebContentsView, its nested render-host `<webview>` guests, AND the
 * service-host window — shared ONE hard-coded `persist:simulator` Electron
 * session. Cookies / localStorage / cache / IndexedDB written by project A were
 * visible to (and clobbered by) project B; two projects open at once cross-
 * contaminate and "clear storage" on one nukes the other.
 *
 * The fix derives a STABLE per-project partition from the project identity:
 * the miniapp `appId` (which flows in via the simulator URL `?appId=` and the
 * spawn path's `appId`) PLUS the project path. appId alone is insufficient —
 * it comes from the project manifest, so two DIFFERENT project paths can declare
 * the SAME appId and would otherwise share a partition; folding the path in
 * isolates them. Same project (same appId + path) → same partition (storage
 * survives a relaunch); different projects → different partitions (no cross-
 * contamination). The shape mirrors the IDE state of the art (WeChat's static
 * partition, ByteDance's `persist:miniapp-<id>` dynamic partition).
 *
 * The protocol handlers (`difile://`, `dmb-resource`) and webRequest policies
 * (referer / CORS) that the simulator runtime needs were installed once on the
 * single `persist:simulator` session. With per-project partitions those have to
 * be (re)applied to EACH project session the first time it is used. The setup
 * sites register a partition-agnostic configurator here; `configureMiniappSession`
 * runs every registered configurator exactly once per partition.
 *
 * Partition CLEANUP (reclaiming on-disk `persist:` data) is intentionally NOT
 * done here — leaving the data on disk is the whole point of a `persist:`
 * partition (cache/storage survives a relaunch). That is a separate concern.
 *
 * MIGRATION (intentional one-time reset): folding the project path into the key
 * means a project that previously ran on the appId-only `persist:miniapp-<appId>`
 * now runs on `persist:miniapp-<appId>-p<hash>` and starts with empty
 * cookies/localStorage/cache. Old data is NOT migrated — a best-effort copy
 * could carry already-cross-contaminated state into the newly isolated space,
 * which defeats the isolation. The reset is accepted as a one-time cost.
 */

import * as electron from 'electron'
import type { Session } from 'electron'

/** The legacy single-session partition. Still used by the pre-warm pool (which
 * is intentionally NOT isolation-aware — see `serviceHostSpec`) and as the
 * fallback when a project key cannot be derived. */
export const SHARED_MINIAPP_PARTITION = 'persist:simulator'

const PARTITION_PREFIX = 'persist:miniapp-'

/**
 * Derive a stable, filesystem-safe partition key from a project `appId`.
 *
 * `appId` is the project identity (e.g. a `wxapp…` id). We pass through the
 * characters Electron is happy to put in a session partition / on-disk folder
 * name (`[A-Za-z0-9_-]`) verbatim so the common case is human-legible, and fold
 * anything else into a short deterministic hash suffix so two appIds that differ
 * only in stripped characters never collide. The same `appId` always yields the
 * same key (so storage survives a relaunch); different `appId`s yield different
 * keys.
 */
export function miniappPartitionKey(appId: string, projectPath?: string | null): string {
  const safe = appId.replace(/[^A-Za-z0-9_-]/g, '')
  // Folding may have dropped distinguishing characters; if the input was not
  // already fully safe, append a deterministic hash of the RAW appId so two
  // distinct appIds can never alias onto the same key.
  const base = safe === appId && safe.length > 0
    ? safe
    : safe.length > 0
      ? `${safe}-${djb2(appId).toString(36)}`
      : djb2(appId).toString(36)
  // `appId` comes from the project manifest, not the path — two DIFFERENT
  // project paths can declare the SAME appId. Fold the project path into the key
  // so those projects get isolated partitions (no storage/cache cross-talk),
  // while the same path always yields the same suffix (a relaunch reuses its
  // storage). Path characters aren't partition-safe, so always hash. Omitting
  // projectPath preserves the legacy appId-only key (pre-warm pool / callers
  // that have no project identity).
  if (!projectPath) return base
  return `${base}-p${djb2(projectPath).toString(36)}`
}

/**
 * The Electron session partition for a project. Returns the SHARED partition
 * when `appId` is empty/unknown (so the runtime still has a session to load on,
 * matching the legacy behavior) and a `persist:miniapp-<key>` partition
 * otherwise.
 */
export function miniappPartition(
  appId: string | null | undefined,
  projectPath?: string | null,
): string {
  if (!appId) return SHARED_MINIAPP_PARTITION
  return `${PARTITION_PREFIX}${miniappPartitionKey(appId, projectPath)}`
}

/** Small, stable string hash (djb2). Not cryptographic — only needs to be
 * deterministic and collision-resistant enough to disambiguate appIds. */
function djb2(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  }
  return h
}

// ── Per-partition session configuration ─────────────────────────────────────
// The simulator runtime needs protocol handlers + webRequest policies on its
// session. With one fixed session those were installed once; with per-project
// partitions they must be applied to each project session. Setup sites register
// a configurator closure (capturing whatever ctx/state it needs); we run each
// configurator exactly once per partition.

type SessionConfigurator = (sess: Session, partition: string) => void

const configurators = new Set<SessionConfigurator>()
const configuredPartitions = new Set<string>()

/**
 * Register a configurator that runs against every miniapp partition session.
 * Already-configured partitions are (re)configured immediately so registration
 * order does not matter. Returns a disposer that unregisters the configurator
 * (it does not undo work already applied to live sessions).
 */
export function registerMiniappSessionConfigurator(fn: SessionConfigurator): () => void {
  configurators.add(fn)
  for (const partition of configuredPartitions) {
    try {
      fn(electron.session.fromPartition(partition), partition)
    } catch (err) {
      console.warn('[miniapp-partition] configurator failed for', partition, err)
    }
  }
  return () => {
    configurators.delete(fn)
  }
}

/**
 * Ensure a partition's session has every registered configurator applied. Safe
 * to call repeatedly per partition (idempotent — each partition is configured
 * once). Call this before loading project content on `partition`.
 *
 * Returns `null` when there is nothing to configure (no configurator registered)
 * so the partition derivation stays independent of any live Electron session —
 * the partition is a constructor-time fact, not a side effect of touching the
 * session API. Setup sites register configurators at app boot; in unit tests
 * that mock `electron` without a `session` export this short-circuits cleanly.
 */
export function configureMiniappSession(partition: string): Session | null {
  // Record that this partition should be configured even if no configurator is
  // registered YET — a later `registerMiniappSessionConfigurator` back-fills it.
  const alreadyConfigured = configuredPartitions.has(partition)
  configuredPartitions.add(partition)
  if (configurators.size === 0) return null
  const sess = electron.session.fromPartition(partition)
  if (alreadyConfigured) return sess
  for (const fn of configurators) {
    try {
      fn(sess, partition)
    } catch (err) {
      console.warn('[miniapp-partition] configurator failed for', partition, err)
    }
  }
  return sess
}

/**
 * Test-only: drop the configurator + configured-partition bookkeeping so each
 * test starts from a clean slate. (Module-level state otherwise leaks across
 * unit tests that mock `electron`.)
 */
export function __resetMiniappSessionConfigForTests(): void {
  configurators.clear()
  configuredPartitions.clear()
}
