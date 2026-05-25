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
	vi.unstubAllGlobals()
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
		expect(complete).toHaveBeenCalledWith({
			data: 'ok',
			statusCode: 201,
			header: { 'x-trace': 'abc', 'content-type': 'text/plain' },
			errMsg: 'uploadFile:ok',
		})
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
		expect(complete).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail abort' })
	})

	it('reports fetch failures when a temp file path cannot be resolved', async () => {
		const ctx = makeContext()
		const fail = vi.fn()
		const complete = vi.fn()
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, statusText: 'Not Found' })))

		uploadFile.call(ctx, {
			uploadId: 'u-missing',
			url: 'https://example.com/upload',
			filePath: 'https://example.com/missing-file',
			name: 'file',
			fail,
			complete,
		})

		await vi.waitFor(() => expect(fail).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail 无法读取文件 https://example.com/missing-file' }))
		expect(complete).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail 无法读取文件 https://example.com/missing-file' })
		expect(MockXMLHttpRequest.instances).toHaveLength(0)
	})

	it('reports xhr network and timeout failures', async () => {
		const ctx = makeContext()
		const networkFail = vi.fn()
		const timeoutFail = vi.fn()

		uploadFile.call(ctx, {
			uploadId: 'u-network',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			fail: networkFail,
		})
		await Promise.resolve()
		MockXMLHttpRequest.instances[0]!.onerror?.()
		expect(networkFail).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail network error' })

		uploadFile.call(ctx, {
			uploadId: 'u-timeout',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			fail: timeoutFail,
		})
		await Promise.resolve()
		MockXMLHttpRequest.instances[1]!.ontimeout?.()
		expect(timeoutFail).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail timeout' })
	})

	it('aborts while temp file resolution is still pending without starting xhr', async () => {
		const ctx = makeContext()
		const fail = vi.fn()
		const complete = vi.fn()
		let resolveFetch!: (response: { ok: boolean; blob: () => Promise<Blob> }) => void
		vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
			resolveFetch = resolve as typeof resolveFetch
		})))

		uploadFile.call(ctx, {
			uploadId: 'u-before-resolve',
			url: 'https://example.com/upload',
			filePath: 'https://example.com/slow-file',
			name: 'file',
			fail,
			complete,
		})
		uploadFileAbort.call(ctx, { uploadId: 'u-before-resolve' })
		expect(MockXMLHttpRequest.instances).toHaveLength(0)

		resolveFetch({ ok: true, blob: async () => new Blob(['slow'], { type: 'text/plain' }) })

		await vi.waitFor(() => expect(fail).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail abort' }))
		expect(complete).toHaveBeenCalledWith({ errMsg: 'uploadFile:fail abort' })
		expect(MockXMLHttpRequest.instances).toHaveLength(0)
	})

	it('ignores abort calls that arrive after an upload has already finished', async () => {
		const ctx = makeContext()
		const firstSuccess = vi.fn()
		const secondFail = vi.fn()

		uploadFile.call(ctx, {
			uploadId: 'u-reused',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			success: firstSuccess,
		})
		await Promise.resolve()
		MockXMLHttpRequest.instances[0]!.status = 200
		MockXMLHttpRequest.instances[0]!.response = 'ok'
		MockXMLHttpRequest.instances[0]!.responseText = 'ok'
		MockXMLHttpRequest.instances[0]!.onload?.()

		uploadFileAbort.call(ctx, { uploadId: 'u-reused' })
		uploadFile.call(ctx, {
			uploadId: 'u-reused',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			fail: secondFail,
		})
		await Promise.resolve()

		expect(firstSuccess).toHaveBeenCalledWith(expect.objectContaining({ errMsg: 'uploadFile:ok' }))
		expect(secondFail).not.toHaveBeenCalled()
		expect(MockXMLHttpRequest.instances).toHaveLength(2)
	})
})

describe('uploadFile timeout default', () => {
	it('defaults xhr.timeout to 60000 when no timeout option is provided', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-timeout-default',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		expect(xhr.timeout).toBe(60000)
	})

	it('uses caller-provided positive timeout as-is', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-timeout-explicit',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			timeout: 30000,
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		expect(xhr.timeout).toBe(30000)
	})

	it('keeps xhr.timeout at 0 when caller explicitly passes timeout: 0', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-timeout-zero',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			timeout: 0,
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		expect(xhr.timeout).toBe(0)
	})
})

describe('uploadFile formData encoding', () => {
	it('serializes plain object formData values via JSON.stringify', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-form-object',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			formData: { meta: { foo: 1 } },
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		const body = xhr.body as FormData
		expect(body.get('meta')).toBe('{"foo":1}')
	})

	it('serializes array formData values via JSON.stringify', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-form-array',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			formData: { list: [1, 2, 3] },
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		const body = xhr.body as FormData
		expect(body.get('list')).toBe('[1,2,3]')
	})

	it('appends Blob formData values as Blob (not stringified)', async () => {
		const ctx = makeContext()
		const blob = new Blob(['payload'], { type: 'application/octet-stream' })

		uploadFile.call(ctx, {
			uploadId: 'u-form-blob',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			formData: { blob },
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		const body = xhr.body as FormData
		const appended = body.get('blob')
		expect(appended).toBeInstanceOf(Blob)
		expect(appended).not.toBe('[object Object]')
	})

	it('coerces primitive number/string formData values via String()', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-form-primitive',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			formData: { n: 42, s: 'str' },
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		const body = xhr.body as FormData
		expect(body.get('n')).toBe('42')
		expect(body.get('s')).toBe('str')
	})

	it('skips null and undefined formData values', async () => {
		const ctx = makeContext()

		uploadFile.call(ctx, {
			uploadId: 'u-form-nullish',
			url: 'https://example.com/upload',
			filePath: 'blob:test-upload',
			name: 'file',
			formData: { a: null, b: undefined, keep: 'yes' } as Record<string, unknown>,
		})
		await Promise.resolve()

		const xhr = MockXMLHttpRequest.instances[0]!
		const body = xhr.body as FormData
		expect(body.has('a')).toBe(false)
		expect(body.has('b')).toBe(false)
		expect(body.get('keep')).toBe('yes')
	})
})
