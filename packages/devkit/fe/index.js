import open from 'open'
import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { app } from './server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Start the dimina-fe server
 * @param {object} opts
 * @param {number} [opts.port=7788] - Port to listen on
 * @param {string} opts.containerDir - Path to the dimina-fe-container directory
 * @param {string} [opts.simulatorDir] - Optional directory containing simulator shell assets
 * @param {boolean} [opts.liveReload=false] - Enable live reload via SSE
 * @param {Array<{ appId: string; name: string; path: string }>} [opts.sessionApps=[]] - Runtime app list injected by caller
 * @returns {Promise<import('http').Server | { server: import('http').Server, reload: () => void }>}
 */
export async function start({ port = 7788, containerDir, outputDir, simulatorDir, liveReload = false, sessionApps = [] } = {}) {
	let liveReloadModule
	const appsDir = outputDir || containerDir

	app.get('/appList.json', (_req, res) => {
		const appListPath = path.join(appsDir, 'appList.json')
		let baseApps = []

		if (fs.existsSync(appListPath)) {
			try {
				baseApps = JSON.parse(fs.readFileSync(appListPath, 'utf-8'))
			}
			catch (error) {
				console.warn(`Failed to parse ${appListPath}:`, error)
			}
		}

		const merged = new Map()
		baseApps.forEach((appInfo) => {
			if (appInfo?.appId) {
				merged.set(appInfo.appId, appInfo)
			}
		})
		sessionApps.forEach((appInfo) => {
			if (appInfo?.appId) {
				merged.set(appInfo.appId, appInfo)
			}
		})

		const filtered = Array.from(merged.values()).filter(appInfo =>
			fs.existsSync(path.join(appsDir, appInfo.appId)),
		)

		res.json(filtered)
	})

	if (outputDir && outputDir !== containerDir) {
		app.use(express.static(outputDir, { index: false }))
	}

	if (liveReload) {
		liveReloadModule = await import('./live-reload.js')
		// Disable auto index so SPA fallback handles script injection
		app.use(express.static(containerDir, { index: false }))
	}
	else {
		app.use(express.static(containerDir))
	}

	if (simulatorDir && fs.existsSync(simulatorDir)) {
		app.use('/simulator', express.static(simulatorDir))
		app.get('/simulator.html', (_req, res) => {
			// `send` defaults to dotfiles: 'ignore' and rejects absolute paths whose
			// parent segments start with '.' (git worktrees under .bare/, hidden
			// caches, etc.) — even though the file itself is not a dotfile.
			res.sendFile(path.join(simulatorDir, 'simulator.html'), { dotfiles: 'allow' })
		})
	}

	// Load proxy server middleware (cors, json, /proxy route)
	await import('./dimina-fe-server/index.js')

	// SPA fallback: serve index.html for navigation-like unmatched routes
	// (no extension or `.html`). Asset-like misses (`.json`, `.js`, `.wxml`,
	// `.css`, source maps, …) must return a real 404 — never HTML. The
	// container's runtime does
	//   fetch(url).then(r => r.text()).then(JSON.parse)
	// for manifests like `<appId>/main/app-config.json`, and serving the SPA
	// shell for such a miss makes `initApp()` die with
	// `SyntaxError: Unexpected token '<', "<!doctype "…` inside an un-
	// handled promise rejection.
	// Express 5 requires a named wildcard parameter instead of bare '*'.
	const spaFallback = liveReload
		? liveReloadModule.injectScript(containerDir)
		: (_req, res) => res.sendFile('index.html', { root: containerDir })

	app.get('/{*path}', (req, res, next) => {
		const ext = path.extname(req.path).toLowerCase()
		if (ext && ext !== '.html') {
			res.status(404).type('text/plain').set('cache-control', 'no-store').send('Not Found')
			return
		}
		return spaFallback(req, res, next)
	})

	return new Promise((resolve, reject) => {
		const server = app.listen(port, async () => {
			console.log(`Server is running on port ${port}`)
			console.log('Press Ctrl+C to stop')
			if (!process.env.DIMINA_NO_OPEN_BROWSER) await open(`http://localhost:${port}`)
			resolve(liveReload ? { server, reload: liveReloadModule.reload } : server)
		})
		server.on('error', (err) => {
			if (err.code === 'EADDRINUSE') {
				console.error(`Port ${port} is already in use. Kill it with: kill $(lsof -t -i :${port})`)
			}
			else {
				console.error('Server error:', err)
			}
			reject(err)
		})
	})
}

// Support direct invocation: node index.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.on('uncaughtException', (err) => {
		console.error('Uncaught Exception:', err)
		process.exit(1)
	})
	process.on('unhandledRejection', (reason, promise) => {
		console.error('Unhandled Rejection at:', promise, 'reason:', reason)
		process.exit(1)
	})

	const containerDir = path.join(__dirname, 'dimina-fe-container')
	start({ port: 7788, containerDir })
}
