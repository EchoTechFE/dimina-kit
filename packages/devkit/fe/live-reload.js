import fs from 'node:fs'
import path from 'node:path'
import { app } from './server.js'

const LIVERELOAD_SCRIPT = `<script>(function(){var es=new EventSource('/__livereload');es.addEventListener('reload',function(){window.location.reload();});}());</script>`

const clients = new Set()

app.get('/__livereload', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache')
	res.setHeader('Connection', 'keep-alive')
	res.flushHeaders()
	clients.add(res)
	req.on('close', () => clients.delete(res))
})

export function reload() {
	for (const client of clients) {
		client.write('event: reload\ndata: \n\n')
	}
}

export function injectScript(containerDir) {
	return (_req, res) => {
		const html = fs.readFileSync(path.join(containerDir, 'index.html'), 'utf-8')
		res.setHeader('Content-Type', 'text/html')
		res.send(html.replace('</body>', `${LIVERELOAD_SCRIPT}</body>`))
	}
}
