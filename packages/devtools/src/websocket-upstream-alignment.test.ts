import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const BUILD_SOURCE = readFileSync(join(ROOT, 'packages/devtools/build-container.js'), 'utf8')
const API_SOURCE = readFileSync(join(ROOT, 'dimina/fe/packages/service/src/api/index.js'), 'utf8')
const SOCKET_SOURCE = readFileSync(
	join(ROOT, 'dimina/fe/packages/service/src/api/core/network/websocket/index.js'),
	'utf8',
)
const SOCKET_TASK_SOURCE = SOCKET_SOURCE.slice(
	SOCKET_SOURCE.indexOf('class SocketTask'),
	SOCKET_SOURCE.indexOf('/**\n * 创建一个 WebSocket 连接'),
)

const BLOCKED_WX_NAMES = [
	'SocketTask',
	'readyState',
	'offSocketOpen',
	'offSocketMessage',
	'offSocketError',
	'offSocketClose',
]

const PRIVATE_TASK_MEMBERS = [
	'readyState',
	'CONNECTING',
	'OPEN',
	'CLOSING',
	'CLOSED',
	'offOpen',
	'offMessage',
	'offError',
	'offClose',
	'socketId',
]

describe('devtools consumes the merged upstream WebSocket public contract', () => {
	it('does not inject a downstream WebSocket service implementation', () => {
		expect(BUILD_SOURCE).not.toContain('service-apis/network/websocket/index.js')
	})

	it('does not retain the removed downstream overlay file', () => {
		expect(existsSync(join(ROOT, 'packages/devtools/src/simulator/service-apis/network/websocket/index.js')))
			.toBe(false)
	})

	it.each(BLOCKED_WX_NAMES)('keeps %s in the authoritative wx blocklist', (name) => {
		expect(API_SOURCE).toContain(`'${name}'`)
	})

	it('exports exactly the seven documented wx WebSocket entry points', () => {
		const exports = [...SOCKET_SOURCE.matchAll(/^export function (\w+)/gm)].map(match => match[1])
		expect(exports).toEqual([
			'connectSocket',
			'sendSocketMessage',
			'closeSocket',
			'onSocketOpen',
			'onSocketMessage',
			'onSocketError',
			'onSocketClose',
		])
	})

	it.each(PRIVATE_TASK_MEMBERS)('does not implement public SocketTask.%s', (name) => {
		if (name === 'socketId') {
			expect(SOCKET_TASK_SOURCE).not.toMatch(/this\.socketId\s*=/)
			return
		}
		expect(SOCKET_TASK_SOURCE).not.toMatch(new RegExp(`(?:get\\s+)?${name}\\s*\\(`))
	})

	it('stores SocketTask state outside the public instance', () => {
		expect(SOCKET_SOURCE).toContain('const socketTaskInternals = new WeakMap()')
	})

	it('rejects non-wss URLs before invoking the native bridge', () => {
		expect(SOCKET_SOURCE).toContain('const WEBSOCKET_URL = /^wss:\\/\\/.*/i')
		expect(SOCKET_SOURCE.indexOf('if (!WEBSOCKET_URL.test(url))'))
			.toBeLessThan(SOCKET_SOURCE.indexOf("invokeAPI('connectSocket', params)"))
	})

	it('uses the base64 plus isBuffer bridge protocol for binary frames', () => {
		expect(SOCKET_SOURCE).toContain('arrayBufferToBase64(data)')
		expect(SOCKET_SOURCE).toContain('base64ToArrayBuffer(value.data)')
	})

	it('keeps task send and close callback-only', () => {
		expect(SOCKET_TASK_SOURCE.match(/invokeAPIWithoutPromise\(/g)).toHaveLength(2)
	})

	it('keeps global close scoped to the bound task instead of sweeping all tasks', () => {
		const globalClose = SOCKET_SOURCE.slice(
			SOCKET_SOURCE.indexOf('export function closeSocket'),
			SOCKET_SOURCE.indexOf('// 全局关闭被 native 拒绝'),
		)
		expect(globalClose).not.toMatch(/for\s*\([^)]*startedTasks/)
	})
})
