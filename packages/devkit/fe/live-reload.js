import fs from 'node:fs'
import path from 'node:path'

/**
 * Swap every stylesheet in place instead of reloading the page — the style
 * hot-reload primitive. Because the compiled CSS scope id is a deterministic
 * hash(path), a recompiled `.css` keeps the SAME `[data-v-<id>]` selectors, so
 * cache-busting each <link> re-applies the new rules against the already-mounted
 * DOM (page stack / form state survive). Recurses into same-origin iframes
 * because dimina renders each page inside a `pageFrame.html` iframe, so the
 * stylesheet <link>s live there, not in the container document.
 *
 * Exported so it can be unit-tested directly in jsdom; it is ALSO serialized via
 * `.toString()` into the injected client script (single source of truth — the
 * shipped client and the test exercise the exact same code).
 */
export function refreshStylesheets(doc) {
	try {
		const links = doc.querySelectorAll('link[rel="stylesheet"]')
		for (const link of links) {
			const u = new URL(link.href, doc.baseURI || undefined)
			u.searchParams.set('__hmr', String(Date.now()))
			const next = link.cloneNode()
			next.href = u.href
			// Remove the stale sheet only AFTER the fresh one loads, so there is no
			// unstyled flash between them.
			next.addEventListener('load', () => link.remove())
			link.parentNode.insertBefore(next, link.nextSibling)
		}
		const frames = doc.querySelectorAll('iframe')
		for (const frame of frames) {
			try {
				if (frame.contentDocument) refreshStylesheets(frame.contentDocument)
			}
			catch {
				// cross-origin iframe — not reachable, skip
			}
		}
	}
	catch {
		// defensive: a refresh must never throw and kill the SSE client
	}
}

// The client injected into the container page: subscribes to both SSE events —
// `reload` (full-page reload for structural changes) and `reload-style` (in-place
// stylesheet swap via the shared refreshStylesheets above).
function buildClientScript() {
	return `<script>(function(){
	var es=new EventSource('/__livereload');
	es.addEventListener('reload',function(){window.location.reload();});
	var refreshStylesheets=${refreshStylesheets.toString()};
	es.addEventListener('reload-style',function(){refreshStylesheets(document);});
}());</script>`
}

/**
 * Attach the live-reload SSE endpoint to ONE server's express app and return
 * that server's `reload`/`reloadStyles`/`injectScript`. A module-level client set
 * would broadcast one session's rebuilds into every other session's pages when
 * several servers run in the same process.
 */
export function createLiveReload(app) {
	const clients = new Set()

	app.get('/__livereload', (req, res) => {
		res.setHeader('Content-Type', 'text/event-stream')
		res.setHeader('Cache-Control', 'no-cache')
		res.setHeader('Connection', 'keep-alive')
		res.flushHeaders()
		clients.add(res)
		req.on('close', () => clients.delete(res))
	})

	function reload() {
		for (const client of clients) {
			client.write('event: reload\ndata: \n\n')
		}
	}

	// Style-only hot reload: tell every connected container to swap its
	// stylesheets in place instead of reloading the whole page.
	function reloadStyles() {
		for (const client of clients) {
			client.write('event: reload-style\ndata: \n\n')
		}
	}

	function injectScript(containerDir) {
		return (_req, res) => {
			const html = fs.readFileSync(path.join(containerDir, 'index.html'), 'utf-8')
			res.setHeader('Content-Type', 'text/html')
			res.send(html.replace('</body>', `${buildClientScript()}</body>`))
		}
	}

	return { reload, reloadStyles, injectScript }
}
