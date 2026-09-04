/**
 * Base URL of this window's bridge on the workbench COI host.
 *
 * Every project window's workbench is served by ONE http listener so they all
 * share an origin (browser storage — IndexedDB, OPFS, caches, service workers
 * — is keyed by origin, and a per-window port would give each window its own
 * bucket that dies with it). A window is told apart by an opaque path prefix
 * instead: `http://127.0.0.1:<port>/w/<token>/`. So the bridge base is the
 * document's own directory, NOT `location.origin` — a root-relative `/__fs`
 * or `/__contrib` URL would leave the prefix behind and reach no window.
 */
export const HOST_BASE_URL = new URL('./', location.href).toString()
