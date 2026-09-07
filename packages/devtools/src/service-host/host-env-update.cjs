/**
 * `hostEnvUpdate` is the ONE message that carries a device change into a
 * running service host (bridge-router's `setDevice` → `applyDeviceToSession`).
 * service.js consumes it for the async `wx.getSystemInfo` path; the sync
 * `wx.getSystemInfoSync()` patch instead reads `__diminaSpawnContext
 * .hostEnvSnapshot` on every call, so the preload merges the same message into
 * that snapshot BEFORE handing it to service.js. Doing it on the same delivery
 * keeps ordering: the `pageResize` that follows in the same batch already sees
 * the new metrics from inside `Page.onResize`.
 *
 * Returns true when the message was a well-formed hostEnvUpdate and the
 * snapshot was replaced; false leaves `ctx` untouched.
 */
function applyHostEnvUpdate(ctx, msg) {
  if (!ctx || typeof ctx !== 'object') return false
  if (!msg || typeof msg !== 'object' || msg.type !== 'hostEnvUpdate') return false
  const systemInfo = msg.body && msg.body.systemInfo
  if (!systemInfo || typeof systemInfo !== 'object') return false
  ctx.hostEnvSnapshot = { ...(ctx.hostEnvSnapshot || {}), ...systemInfo }
  return true
}

module.exports = { applyHostEnvUpdate }
