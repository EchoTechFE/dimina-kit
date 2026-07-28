import { webContents, type WebContentsView } from 'electron'

/**
 * Injected into each live render-host guest to hot-swap its stylesheets in
 * place: for every `<link rel=stylesheet>`, insert a cache-busted clone
 * (`?__hmr=<ts>`) so the browser re-fetches the recompiled `.css` and re-applies
 * it against the already-mounted DOM, then drop the stale sheet once the fresh
 * one loads (no unstyled flash). Recurses into same-origin iframes because a
 * render-host page nests its content in an iframe. Self-contained (runs in the
 * guest realm via `executeJavaScript`), defensive (never throws). Mirrors
 * `@dimina-kit/devkit`'s `refreshStylesheets` (the SSE web-preview equivalent).
 */
const REFRESH_STYLES_JS = `(function refresh(doc){
  try {
    var links = doc.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      try {
        var u = new URL(link.href, doc.baseURI || undefined);
        u.searchParams.set('__hmr', String(Date.now()));
        var next = link.cloneNode();
        next.href = u.href;
        next.addEventListener('load', (function(stale){ return function(){ stale.remove(); }; })(link));
        link.parentNode.insertBefore(next, link.nextSibling);
      } catch (e) {}
    }
    var frames = doc.querySelectorAll('iframe');
    for (var j = 0; j < frames.length; j++) {
      try { if (frames[j].contentDocument) refresh(frames[j].contentDocument); } catch (e) {}
    }
  } catch (e) {}
})(document);`

/**
 * Hot-swap the stylesheets of every live render-host guest of `view` in place
 * (no shell respawn — page stack / form state / scroll / focus survive). Guests
 * are found via `hostWebContents === view.webContents` — the same nesting
 * pattern the zoom propagation uses. Returns false when no live guest is found,
 * so the caller can fall back to a full reload rather than dropping the edit.
 */
export function refreshGuestStylesheets(view: WebContentsView): boolean {
	const simWc = view.webContents
	let refreshed = 0
	try {
		for (const wc of webContents.getAllWebContents()) {
			if (wc.isDestroyed()) continue
			if (wc.hostWebContents !== simWc) continue
			wc.executeJavaScript(REFRESH_STYLES_JS).catch(() => { /* guest torn down mid-refresh */ })
			refreshed++
		}
	}
	catch {
		return false
	}
	return refreshed > 0
}
