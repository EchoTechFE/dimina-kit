import fs from 'node:fs'
import path from 'node:path'

const LIVERELOAD_SCRIPT = `<script>(function(){var es=new EventSource('/__livereload');es.addEventListener('reload',function(){window.location.reload();});}());</script>`

/**
 * Attach the live-reload SSE endpoint to ONE server's express app and return
 * that server's `reload`/`injectScript`. A module-level client set would
 * broadcast one session's rebuilds into every other session's pages when
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

	function injectScript(containerDir) {
		return (_req, res) => {
			const html = fs.readFileSync(path.join(containerDir, 'index.html'), 'utf-8')
			res.setHeader('Content-Type', 'text/html')
			res.send(html.replace('</body>', `${LIVERELOAD_SCRIPT}</body>`))
		}
	}

	return { reload, injectScript }
}
