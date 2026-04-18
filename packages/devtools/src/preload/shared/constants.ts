/** Preload-only timing constants for instrumentation. */

/** Debounce delay for WXML MutationObserver callbacks. */
export const WXML_DEBOUNCE_MS = 300

/** Interval between WXML attachment retries. */
export const WXML_RETRY_INTERVAL_MS = 500

/** Maximum time to keep retrying WXML attachment. */
export const WXML_RETRY_TIMEOUT_MS = 10_000

/** Interval for polling Vue app readiness during navigation. */
export const NAVIGATION_POLL_INTERVAL_MS = 200

/** Maximum time to wait for Vue app during navigation. */
export const NAVIGATION_TIMEOUT_MS = 10_000

/** Maximum number of retries for simulator webview attachment. */
export const MAX_ATTACH_RETRIES = 50

/** Interval between simulator attachment retries. */
export const ATTACH_RETRY_INTERVAL_MS = 200
