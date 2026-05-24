import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { registerTempFilePath } from './temp-files'
import { uploadFile, uploadFileAbort } from './simulator-api'

type XhrHandler = ((event?: unknown) => void) | null

class MockXMLHttpRequest {
	static HEADERS_RECEIVED = 2
	static instances: MockXMLHttpRequest[] = []

	readyState = 0
	status = 0
	response = ''
	responseText = ''
	timeout = 0
	upload: { onprogress: XhrHandler } = { onprogress: null }
	onreadystatechange: XhrHandler = null
	onload: XhrHandler = null
	onerror: XhrHandler = null
	ontimeout: XhrHandler = null
	onabort: XhrHandler = null
	headers: Record<string, string> = {}
	body: unknown
	open = vi.fn()

	constructor() {
		MockXMLHttpRequest.instances.push(this)
	}

	setRequestHeader(key: string, value: string) {
		this.headers[key] = value
	}

	getAllResponseHeaders() {
		return 'x-trace: abc\r\ncontent-type: text/plain\r\n'
	}

	send(body: unknown) {
		this.body = body
	}

	abort() {
		this.onabort?.()
	}
}

const RealXMLHttpRequest = globalThis.XMLHttpRequest

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) => (typeof fn === 'function' ? fn : undefined)),
	} as unknown as MiniAppContext
}

beforeEach(() => {
	MockXMLHttpRequest.instances = []
	vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest)
	registerTempFilePath('blob:test-upload', new Blob(['hello'], { type: 'text/plain' }))
})

afterEach(() => {
	vi.stubGlobal('XMLHttpRequest', RealXMLHttpRequest)
	vi.restoreAllMocks()
})

describe('container uploadFile', () => {
	it('uploads a temp file as multipart data and reports success/progress/headers', async () => {
		const ctx = makeContext()
		const success = vi.fn()
		const complete = vi.fn()
		const progress = vi.fn()
		const headersReceived = vi.fn()

		uploadFile.call(ctx, {
			uploadId: 'u1',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			header: {
				Authorization: 'Bearer token',
				Referer: 'https://blocked.example',
				'Content-Type': 'application/json',
			},
			formData: { scene: 'devtools' },
			success,
			complete,
			progress,
			headersReceived,
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		expect(xhr.open).toHaveBeenCalledWith('POST', 'https://example.com/upload', true)
		expect(xhr.headers).toEqual({ Authorization: 'Bearer token' })
		expect(xhr.body).toBeInstanceOf(FormData)

		xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
		expect(progress).toHaveBeenCalledWith({
			progress: 50,
			totalBytesSent: 5,
			totalBytesExpectedToSend: 10,
		})

		xhr.readyState = MockXMLHttpRequest.HEADERS_RECEIVED
		xhr.onreadystatechange?.()
		expect(headersReceived).toHaveBeenCalledWith({
			header: { 'x-trace': 'abc', 'content-type': 'text/plain' },
		})

		xhr.status = 201
		xhr.responseText = 'ok'
		xhr.response = 'ok'
		xhr.onload?.()

		expect(success).toHaveBeenCalledWith({
			data: 'ok',
			statusCode: 201,
			header: { 'x-trace': 'abc', 'content-type': 'text/plain' },
			errMsg: 'uploadFile:ok',
		})
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('aborts an in-flight upload by uploadId', async () => {
		const ctx = makeContext()
		const fail = vi.fn()
		const complete = vi.fn()

		uploadFile.call(ctx, {
			uploadId: 'u2',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			fail,
			complete,
		})
		await Promise.resolve()

		uploadFileAbort.call(ctx, { uploadId: 'u2' })

		expect(fail).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail abort' })
		expect(complete).toHaveBeenCalledTimes(1)
	})
})
