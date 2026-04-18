import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import chokidar from 'chokidar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const build = require('@dimina/compiler') as typeof import('@dimina/compiler').default

// esbuild's native binary is shipped inside node_modules, but when packaged
// via electron-builder it lives in app.asar. asarUnpack puts the real binary
// in app.asar.unpacked — but esbuild computes its binary path from __dirname,
// which still points inside app.asar. Redirect it explicitly via require.resolve
// so we don't hard-code the hoisting depth (pnpm vs npm layouts differ).
if (!process.env.ESBUILD_BINARY_PATH && __dirname.includes('app.asar')) {
	const platform = `${process.platform}-${process.arch}`
	try {
		const resolved = require.resolve(`@esbuild/${platform}/bin/esbuild`)
		process.env.ESBUILD_BINARY_PATH = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
	}
	catch {
		// fall through — esbuild will surface a clearer error if the binary is truly missing
	}
}

function getRandomPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.listen(0, () => {
			const port = (srv.address() as import('node:net').AddressInfo).port
			srv.close(() => resolve(port))
		})
		srv.on('error', reject)
	})
}

type FeStart = (opts: {
	port?: number
	containerDir: string
	outputDir?: string
	simulatorDir?: string
	liveReload?: boolean
	sessionApps?: Array<{ appId: string; name: string; path: string }>
}) => Promise<{ server: Server; reload: () => void }>

export interface AppInfo {
	appId: string
	name: string
	path: string
}

export interface ProjectSession {
	appInfo: AppInfo
	port: number
	close: () => Promise<void>
}

export async function openProject(opts: {
	projectPath: string
	port?: number
	sourcemap?: boolean
	simulatorDir?: string
	containerDir?: string
	outputDir?: string
	onRebuild?: () => void
	onBuildError?: (err: unknown) => void
}): Promise<ProjectSession> {
	const {
		projectPath: rawProjectPath,
		port = 0,
		sourcemap = false,
		simulatorDir,
		containerDir: overrideContainerDir,
		outputDir,
		onRebuild,
		onBuildError,
	} = opts
	const projectPath = path.resolve(rawProjectPath)
	const buildOptions = { sourcemap }

	const resolvedPort = port === 0 ? await getRandomPort() : port

	const containerDir = overrideContainerDir ?? path.join(__dirname, '..', 'fe', 'dimina-fe-container')
	const prevCwd = process.cwd()
	const resolvedOutputDir = outputDir
		?? path.join(os.tmpdir(), 'dimina-kit', createHash('sha1').update(projectPath).digest('hex').slice(0, 12))
	fs.mkdirSync(resolvedOutputDir, { recursive: true })

	let initialAppInfo: AppInfo | null
	try {
		process.chdir(projectPath)
		initialAppInfo = (await build(resolvedOutputDir, projectPath, true, buildOptions)) as AppInfo | null
	}
	finally {
		process.chdir(prevCwd)
	}
	const sessionApps: AppInfo[] = initialAppInfo ? [initialAppInfo] : []

	process.env.DIMINA_NO_OPEN_BROWSER = '1'
	const fe = await import('../fe/index.js' as string)
	const start = fe.start as FeStart
	const { server, reload } = await start({
		port: resolvedPort,
		containerDir,
		outputDir: resolvedOutputDir,
		simulatorDir,
		liveReload: true,
		sessionApps,
	})

	const watcher = chokidar.watch(projectPath, {
		ignored: /(^|[/\\])\../,
		persistent: true,
		ignoreInitial: true,
	})

	let isBuilding = false
	watcher.on('change', async () => {
		if (isBuilding) return
		isBuilding = true
		try {
			process.chdir(projectPath)
			const rebuilt = (await build(resolvedOutputDir, projectPath, true, buildOptions)) as AppInfo | null
			if (rebuilt) {
				const idx = sessionApps.findIndex(a => a.appId === rebuilt.appId)
				if (idx === -1) sessionApps.push(rebuilt)
				else sessionApps[idx] = rebuilt
			}
			reload?.()
			onRebuild?.()
		}
		catch (e) {
			onBuildError?.(e)
		}
		finally {
			process.chdir(prevCwd)
			isBuilding = false
		}
	})

	return {
		appInfo: initialAppInfo ?? { appId: 'unknown', name: path.basename(projectPath), path: projectPath },
		port: resolvedPort,
		close: async () => {
			await watcher.close()
			;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}
