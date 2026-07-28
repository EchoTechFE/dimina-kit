// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createLiveReload, refreshStylesheets } from '../fe/live-reload.js'

function makeFakeRes() {
	const chunks: string[] = []
	return {
		setHeader: vi.fn(),
		flushHeaders: vi.fn(),
		write: vi.fn((chunk: string) => {
			chunks.push(chunk)
		}),
		chunks,
	}
}

function makeFakeReq() {
	const emitter = new EventEmitter()
	return {
		on: (ev: string, cb: (...args: unknown[]) => void) => {
			emitter.on(ev, cb)
			return emitter
		},
		emit: (ev: string, ...args: unknown[]) => emitter.emit(ev, ...args),
	}
}

describe('refreshStylesheets', () => {
	it('appends a sibling link with a cache-busting __hmr param for a stylesheet link', () => {
		document.head.innerHTML = '<link rel="stylesheet" href="/style.css">'

		refreshStylesheets(document)

		const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
		const withHmr = links.filter((link) => (link as HTMLLinkElement).href.includes('__hmr'))
		expect(withHmr).toHaveLength(1)
	})

	it('does not touch non-stylesheet links', () => {
		document.head.innerHTML = '<link rel="icon" href="/favicon.ico">'

		refreshStylesheets(document)

		const links = Array.from(document.querySelectorAll('link'))
		expect(links).toHaveLength(1)
		expect(links.some((link) => link.href.includes('__hmr'))).toBe(false)
	})

	it('recurses into a same-origin iframe and refreshes its inner stylesheet', () => {
		document.body.innerHTML = ''
		const iframe = document.createElement('iframe')
		document.body.appendChild(iframe)

		const innerDoc = iframe.contentDocument
		expect(innerDoc).toBeTruthy()
		const innerLink = innerDoc!.createElement('link')
		innerLink.rel = 'stylesheet'
		innerLink.href = 'x.css'
		innerDoc!.head.appendChild(innerLink)

		refreshStylesheets(document)

		const innerLinks = Array.from(innerDoc!.querySelectorAll('link[rel="stylesheet"]'))
		expect(innerLinks.some((link) => (link as HTMLLinkElement).href.includes('__hmr'))).toBe(
			true,
		)
	})

	it('does not throw on an empty document', () => {
		document.head.innerHTML = ''
		document.body.innerHTML = ''
		expect(() => refreshStylesheets(document)).not.toThrow()
	})
})

describe('createLiveReload', () => {
	function setup() {
		const routes: Record<string, (req: unknown, res: unknown) => void> = {}
		const app = {
			get: (p: string, h: (req: unknown, res: unknown) => void) => {
				routes[p] = h
			},
		}
		const liveReload = createLiveReload(app)
		return { routes, app, liveReload }
	}

	function connectClient(routes: Record<string, (req: unknown, res: unknown) => void>) {
		const req = makeFakeReq()
		const res = makeFakeRes()
		const handler = routes['/__livereload']
		if (typeof handler !== 'function') throw new Error('handler not registered')
		handler(req, res)
		return { req, res }
	}

	it('registers a GET handler for /__livereload', () => {
		const { routes } = setup()
		expect(routes['/__livereload']).toBeTypeOf('function')
	})

	it('reload() broadcasts an event: reload chunk to connected clients', () => {
		const { routes, liveReload } = setup()
		const { res } = connectClient(routes)

		liveReload.reload()

		expect(res.chunks.some((chunk) => chunk.includes('event: reload\n'))).toBe(true)
	})

	it('reloadStyles() broadcasts an event: reload-style chunk to connected clients', () => {
		const { routes, liveReload } = setup()
		const { res } = connectClient(routes)

		liveReload.reloadStyles()

		expect(res.chunks.some((chunk) => chunk.includes('event: reload-style\n'))).toBe(true)
	})

	it('stops writing to a client after its request closes', () => {
		const { routes, liveReload } = setup()
		const { req, res } = connectClient(routes)

		req.emit('close')
		res.chunks.length = 0
		liveReload.reload()

		expect(res.write).not.toHaveBeenCalled()
		expect(res.chunks).toHaveLength(0)
	})

	it('reload() only writes to still-connected clients, not a closed one, when multiple are connected', () => {
		const { routes, liveReload } = setup()
		const clientA = connectClient(routes)
		const clientB = connectClient(routes)

		clientA.req.emit('close')
		liveReload.reload()

		expect(clientA.res.chunks.some((chunk) => chunk.includes('event: reload\n'))).toBe(false)
		expect(clientB.res.chunks.some((chunk) => chunk.includes('event: reload\n'))).toBe(true)
	})
})
