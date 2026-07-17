// Pure write-back step of the AppData-panel edit path: resolve the page
// instance owning `bridgeId` in the CURRENT page stack and hand the patch to
// its real `setData`, so the update flows through the runtime's own pipeline
// (observers, child-props sync, `ub` publish) and the panel re-renders from
// the runtime's state — never an optimistic local echo.
//
// `getCurrentPages` is injected (the service runtime installs it on
// `globalThis` during boot; this module stays testable without that global).
// Returns whether the patch reached a live page; every failure — no runtime
// yet, unknown bridge, a throwing setData — degrades to `false` and never
// throws into the preload's IPC listener.
'use strict'

/**
 * @param {unknown} getCurrentPages
 * @param {string} bridgeId
 * @param {Record<string, unknown>} data
 * @returns {boolean}
 */
function applyAppDataSetData(getCurrentPages, bridgeId, data) {
  if (typeof getCurrentPages !== 'function') return false
  let pages
  try {
    pages = getCurrentPages()
  } catch (_) {
    return false
  }
  if (!Array.isArray(pages)) return false
  const page = pages.find((p) => p && p.bridgeId === bridgeId)
  if (!page || typeof page.setData !== 'function') return false
  try {
    page.setData(data)
  } catch (_) {
    return false
  }
  return true
}

module.exports = { applyAppDataSetData }
