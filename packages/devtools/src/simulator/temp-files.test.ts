import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tempFilesModule from './temp-files'

const {
	createTempFilePath,
	registerTempFilePath,
	resolveTempFilePath,
	revokeTempFilePath,
	revokeAllTempFilePaths,
} = tempFilesModule

// `setTempFileSink` is the new sink-injection API added by the "blob: →
// difile://" refactor. Accessing it via the module namespace keeps this file
// type-checkable before the implementation lands — at runtime it will be
// `undefined`, which causes the new tests to fail until the API is added.
const setTempFileSink = (
	tempFilesModule as unknown as {
		setTempFileSink?: (sink: TempFileSink | null) => void
	}
).setTempFileSink as (sink: TempFileSink | null) => void

interface TempFileSink {
	write(path: string, blob: Blob): void
	revoke(path: string): void
	revokeAll(): void
}

const DIFILE_RE = /^difile:\/\/_tmp\//

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
	// Install spies for URL.createObjectURL / URL.revokeObjectURL so we can
	// assert they are NEVER called by the new difile:// implementation.
	createSpy = vi.fn(() => 'blob:should-not-be-used')
	revokeSpy = vi.fn()
	Object.defineProperty(URL, 'createObjectURL', {
		configurable: true,
		value: createSpy,
	})
	Object.defineProperty(URL, 'revokeObjectURL', {
		configurable: true,
		value: revokeSpy,
	})
	// Defensively flush any state earlier tests may have left behind.
	if (typeof revokeAllTempFilePaths === 'function') revokeAllTempFilePaths()
	createSpy.mockClear()
	revokeSpy.mockClear()
})

afterEach(() => {
	// Always detach sink + clear the Map so tests are isolated.
	if (typeof setTempFileSink === 'function') setTempFileSink(null)
	if (typeof revokeAllTempFilePaths === 'function') revokeAllTempFilePaths()
	if (originalCreateObjectURL) {
		Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
	} else {
		delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
	}
	if (originalRevokeObjectURL) {
		Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
	} else {
		delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
	}
	vi.restoreAllMocks()
})

function makeSink(): TempFileSink & {
	writeMock: ReturnType<typeof vi.fn>
	revokeMock: ReturnType<typeof vi.fn>
	revokeAllMock: ReturnType<typeof vi.fn>
} {
	const writeMock = vi.fn()
	const revokeMock = vi.fn()
	const revokeAllMock = vi.fn()
	return {
		write: writeMock,
		revoke: revokeMock,
		revokeAll: revokeAllMock,
		writeMock,
		revokeMock,
		revokeAllMock,
	}
}

describe('temp-files difile:// path generation', () => {
	it('createTempFilePath returns difile:// path and does NOT call URL.createObjectURL even when it exists', () => {
		const blob = new Blob(['hello'], { type: 'text/plain' })
		const path = createTempFilePath(blob)

		expect(path).toMatch(DIFILE_RE)
		expect(createSpy).not.toHaveBeenCalled()
	})

	it('createTempFilePath emits unique paths across calls', () => {
		const a = createTempFilePath(new Blob(['a']))
		const b = createTempFilePath(new Blob(['b']))
		const c = createTempFilePath(new Blob(['c']))

		expect(a).toMatch(DIFILE_RE)
		expect(b).toMatch(DIFILE_RE)
		expect(c).toMatch(DIFILE_RE)
		expect(new Set([a, b, c]).size).toBe(3)
	})

	it('URL.revokeObjectURL is never called by createTempFilePath / revokeTempFilePath / revokeAllTempFilePaths', () => {
		const blob1 = new Blob(['a'])
		const blob2 = new Blob(['b'])
		const p1 = createTempFilePath(blob1)
		const p2 = createTempFilePath(blob2)

		revokeTempFilePath(p1)
		revokeAllTempFilePaths()

		expect(createSpy).not.toHaveBeenCalled()
		expect(revokeSpy).not.toHaveBeenCalled()
		// `p2` is just here to make sure revokeAllTempFilePaths is exercised
		// against a non-empty Map.
		expect(p2).toMatch(DIFILE_RE)
	})
})

describe('temp-files in-memory behaviour (no sink)', () => {
	it('without sink, resolveTempFilePath still returns the registered Blob from memory', async () => {
		const blob = new Blob(['cached'], { type: 'text/plain' })
		const path = createTempFilePath(blob)

		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)

		const resolved = await resolveTempFilePath(path)
		expect(resolved).toBe(blob)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('revokeTempFilePath removes the entry so resolveTempFilePath falls back to fetch', async () => {
		const blob = new Blob(['cached'], { type: 'text/plain' })
		const path = createTempFilePath(blob)

		revokeTempFilePath(path)

		const fetched = new Blob(['from-network'], { type: 'text/plain' })
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			blob: () => Promise.resolve(fetched),
		})
		vi.stubGlobal('fetch', fetchSpy)
		const result = await resolveTempFilePath(path)
		expect(fetchSpy).toHaveBeenCalledWith(path)
		expect(result).toBe(fetched)
	})

	it('revokeTempFilePath is a silent no-op for unknown paths', () => {
		expect(() => revokeTempFilePath('difile://_tmp/never-registered')).not.toThrow()
	})

	it('revokeAllTempFilePaths empties the Map so subsequent resolve falls back to fetch', async () => {
		const path = createTempFilePath(new Blob(['gone']))

		revokeAllTempFilePaths()

		const fetched = new Blob(['from-network'])
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			blob: () => Promise.resolve(fetched),
		})
		vi.stubGlobal('fetch', fetchSpy)

		const result = await resolveTempFilePath(path)
		expect(fetchSpy).toHaveBeenCalledWith(path)
		expect(result).toBe(fetched)
	})

	it('registerTempFilePath stores a Blob under an arbitrary path so it can be resolved from memory', async () => {
		const blob = new Blob(['inline'], { type: 'text/plain' })
		registerTempFilePath('difile://_tmp/manual-1', blob)

		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)

		const resolved = await resolveTempFilePath('difile://_tmp/manual-1')
		expect(resolved).toBe(blob)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('revokeAllTempFilePaths followed by a fresh createTempFilePath returns a new difile:// path', () => {
		const before = createTempFilePath(new Blob(['x']))
		revokeAllTempFilePaths()
		const after = createTempFilePath(new Blob(['y']))

		expect(before).toMatch(DIFILE_RE)
		expect(after).toMatch(DIFILE_RE)
		expect(after).not.toBe(before)
	})
})

describe('temp-files sink wiring (setTempFileSink)', () => {
	it('when sink installed, createTempFilePath calls sink.write exactly once with returned path and blob', () => {
		const sink = makeSink()
		setTempFileSink(sink)

		const blob = new Blob(['hello'], { type: 'text/plain' })
		const path = createTempFilePath(blob)

		expect(sink.writeMock).toHaveBeenCalledTimes(1)
		expect(sink.writeMock).toHaveBeenCalledWith(path, blob)
	})

	it('registerTempFilePath also triggers sink.write', () => {
		const sink = makeSink()
		setTempFileSink(sink)

		const blob = new Blob(['inline'], { type: 'text/plain' })
		registerTempFilePath('difile://_tmp/manual-2', blob)

		expect(sink.writeMock).toHaveBeenCalledTimes(1)
		expect(sink.writeMock).toHaveBeenCalledWith('difile://_tmp/manual-2', blob)
	})

	it('revokeTempFilePath triggers sink.revoke with the same path', () => {
		const sink = makeSink()
		setTempFileSink(sink)

		const path = createTempFilePath(new Blob(['a']))
		sink.writeMock.mockClear()

		revokeTempFilePath(path)

		expect(sink.revokeMock).toHaveBeenCalledTimes(1)
		expect(sink.revokeMock).toHaveBeenCalledWith(path)
		// revoke must not also fire write or revokeAll
		expect(sink.writeMock).not.toHaveBeenCalled()
		expect(sink.revokeAllMock).not.toHaveBeenCalled()
	})

	it('revokeAllTempFilePaths triggers sink.revokeAll exactly once (NOT per path)', () => {
		const sink = makeSink()
		setTempFileSink(sink)

		createTempFilePath(new Blob(['a']))
		createTempFilePath(new Blob(['b']))
		createTempFilePath(new Blob(['c']))
		sink.writeMock.mockClear()
		sink.revokeMock.mockClear()

		revokeAllTempFilePaths()

		expect(sink.revokeAllMock).toHaveBeenCalledTimes(1)
		expect(sink.revokeMock).not.toHaveBeenCalled()
	})

	it('setTempFileSink(null) detaches; subsequent ops do not call previous sink', () => {
		const sink = makeSink()
		setTempFileSink(sink)
		setTempFileSink(null)

		const path = createTempFilePath(new Blob(['a']))
		registerTempFilePath('difile://_tmp/detached', new Blob(['b']))
		revokeTempFilePath(path)
		revokeAllTempFilePaths()

		expect(sink.writeMock).not.toHaveBeenCalled()
		expect(sink.revokeMock).not.toHaveBeenCalled()
		expect(sink.revokeAllMock).not.toHaveBeenCalled()
	})

	it('setTempFileSink replaces a previously installed sink', () => {
		const first = makeSink()
		const second = makeSink()
		setTempFileSink(first)
		setTempFileSink(second)

		const blob = new Blob(['a'], { type: 'text/plain' })
		const path = createTempFilePath(blob)
		revokeTempFilePath(path)
		revokeAllTempFilePaths()

		// First sink must not see any callbacks after being replaced.
		expect(first.writeMock).not.toHaveBeenCalled()
		expect(first.revokeMock).not.toHaveBeenCalled()
		expect(first.revokeAllMock).not.toHaveBeenCalled()

		// Second sink receives the new traffic.
		expect(second.writeMock).toHaveBeenCalledTimes(1)
		expect(second.writeMock).toHaveBeenCalledWith(path, blob)
		expect(second.revokeMock).toHaveBeenCalledTimes(1)
		expect(second.revokeMock).toHaveBeenCalledWith(path)
		expect(second.revokeAllMock).toHaveBeenCalledTimes(1)
	})

	it('URL.revokeObjectURL is never called by any of these APIs (with or without sink)', () => {
		const sink = makeSink()
		setTempFileSink(sink)

		const a = createTempFilePath(new Blob(['a']))
		const b = createTempFilePath(new Blob(['b']))
		registerTempFilePath('difile://_tmp/manual-3', new Blob(['c']))

		revokeTempFilePath(a)
		revokeAllTempFilePaths()

		setTempFileSink(null)
		const c = createTempFilePath(new Blob(['d']))
		revokeTempFilePath(c)
		revokeAllTempFilePaths()

		expect(createSpy).not.toHaveBeenCalled()
		expect(revokeSpy).not.toHaveBeenCalled()
		// `b` is just here to make sure the multi-entry path is exercised.
		expect(b).toMatch(DIFILE_RE)
	})
})
