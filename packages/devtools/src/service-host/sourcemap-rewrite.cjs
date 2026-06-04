'use strict'

/**
 * Rewrite a fetched script's RELATIVE `//# sourceMappingURL=` directive to an
 * ABSOLUTE URL resolved against the script's own fetch URL.
 *
 * Why this exists (native-host console file links):
 *   The service host loads each compiled `logic.js` via the `importScripts`
 *   shim in preload.cjs — a synchronous XHR + `(0, eval)(...)`. The compiled
 *   bundle ships a RELATIVE `//# sourceMappingURL=logic.js.map`
 *   (compiler/core/logic-compiler.js). A real Web Worker `importScripts(url)`
 *   gives the script the dev-server URL as its base, so DevTools resolves the
 *   relative map against `…/{appId}/{root}/logic.js` and fetches the right
 *   `.map`. Under `(0, eval)(...)` the script has NO base URL of its own, so
 *   DevTools resolves a relative `sourceMappingURL` against the service-host
 *   DOCUMENT (`file://…/service-host/service.html`) and 404s — console
 *   file:line links then point at the compiled bundle, not the developer's
 *   original source. Rewriting the directive to an absolute dev-server URL
 *   restores sourcemapped console frames + Sources links.
 *
 * Contract:
 *   - Operates on the LAST `//# sourceMappingURL=` (or legacy `//@`) directive
 *     (the compiler appends exactly one as the final line).
 *   - Leaves an already-absolute (`http(s)://`, `//host`, `data:`, `file:`) map
 *     URL untouched — only relative specifiers are resolved.
 *   - Leaves source with no directive untouched.
 *   - On any parse/resolve failure, returns the input unchanged (console
 *     sourcemap fidelity is best-effort; it must never break script loading).
 *
 * @param {string} source     The fetched script body.
 * @param {string} scriptUrl  The absolute URL the script was fetched from.
 * @returns {string} The body with an absolute sourceMappingURL (or unchanged).
 */
function rewriteSourceMappingUrl(source, scriptUrl) {
  if (typeof source !== 'string' || !source) return source
  const re = /(^|\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\n]*)/g
  let lastIndex = -1
  let lastValue = ''
  let m
  while ((m = re.exec(source)) !== null) {
    lastIndex = m.index + m[1].length
    lastValue = (m[2] || '').trim()
  }
  if (lastIndex < 0 || !lastValue) return source
  // Already absolute (scheme://, protocol-relative //host, or data:)? Leave it.
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(lastValue) || /^data:/i.test(lastValue)) return source
  let absolute
  try {
    absolute = new URL(lastValue, scriptUrl).toString()
  } catch (_) {
    return source
  }
  // Drop the original (relative) directive line, re-emit an absolute one.
  const head = source.slice(0, lastIndex)
  return `${head}\n//# sourceMappingURL=${absolute}`
}

module.exports = { rewriteSourceMappingUrl }
