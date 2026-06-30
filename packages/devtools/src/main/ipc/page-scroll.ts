/**
 * Build the script that `wx.pageScrollTo` runs inside the page's render guest.
 *
 * The mini-program page scrolls the whole render document (the native iOS impl
 * scrolls the WKWebView's scrollView; Android scrolls the page view), so the
 * simulator scrolls `window`. `duration` is best-effort: a positive duration
 * maps to smooth scrolling (the browser owns the easing — the exact ms is not
 * controllable), and `0` jumps instantly.
 */
export function buildPageScrollScript(params: { scrollTop?: unknown; duration?: unknown }): string {
  const rawTop = Number(params.scrollTop)
  const top = Number.isFinite(rawTop) ? rawTop : 0
  const duration = params.duration === undefined ? 300 : Number(params.duration)
  const behavior = Number.isFinite(duration) && duration > 0 ? 'smooth' : 'auto'
  return `window.scrollTo({ top: ${top}, left: 0, behavior: ${JSON.stringify(behavior)} })`
}
