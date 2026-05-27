/**
 * `defineEvent()` 创建的事件未在 `WorkbenchConfig.events` 中显式列出时，
 * `publish()` 会抛此错。避免 module-load-order 隐式注册。
 */
export class UndeclaredHostEventError extends Error {
	readonly eventName: string
	constructor(eventName: string) {
		super(
			`HostEvent "${eventName}" was not declared in WorkbenchConfig.events. ` +
				`Add it to the events array so the framework knows to bind a transport for it.`,
		)
		this.name = 'UndeclaredHostEventError'
		this.eventName = eventName
	}
}

/**
 * 在 Init / Bind 阶段调用 `HostEvent.publish()` 时抛 —— transport 尚未就绪。
 * Setup / Ready 之后调用是安全的（fire-and-forget，无 replay）。
 */
export class EventNotBoundError extends Error {
	readonly eventName: string
	constructor(eventName: string) {
		super(
			`HostEvent "${eventName}" publish() called before transport is bound. ` +
				`publish() is safe only from Setup phase onward.`,
		)
		this.name = 'EventNotBoundError'
		this.eventName = eventName
	}
}

/**
 * webview 调 `client.ready()` 时 framework bridge 不在 `window` 上（host preload
 * 漏装 `exposeWorkbenchBridge()`）。
 */
export class WorkbenchClientNotReadyError extends Error {
	constructor(message = 'Workbench framework bridge is missing on window — did the host preload call exposeWorkbenchBridge()?') {
		super(message)
		this.name = 'WorkbenchClientNotReadyError'
	}
}

/**
 * `client.invoke(name, ...)` 时远端 hostServices handler 抛错的封装。
 * 保留原 error message，附带 remoteName / 可选 code 让 webview 侧便于分类。
 */
export class WorkbenchRemoteError extends Error {
	readonly remoteName: string
	readonly code?: string
	constructor(remoteName: string, message: string, code?: string) {
		super(message)
		this.name = 'WorkbenchRemoteError'
		this.remoteName = remoteName
		if (code !== undefined) this.code = code
	}
}
