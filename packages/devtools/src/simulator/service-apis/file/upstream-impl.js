/**
 * Test-resolution stand-in for the injected `./upstream-impl.js`.
 *
 * In the real container build, `build-container.js` preserves the genuine
 * upstream `service/src/api/core/file/index.js` at this path before
 * overlaying `index.js` with the devtools shim, so the shim's import
 * resolves to the real upstream implementation and this file never enters
 * the bundle. Outside that build (vitest importing the shim directly), this
 * stand-in satisfies the import with an inert manager so the shim module
 * loads and its static exports stay checkable.
 *
 * `getFileSystemManager()` here also has to reproduce the *shape* upstream
 * builds, not just answer with any object: upstream copies its prototype
 * methods onto the instance as bound own properties (see
 * `dimina/fe/packages/service/src/api/core/file/index.js`), which shadow
 * whatever the shim later assigns onto the prototype. Only a stand-in that
 * does the same binding lets a vitest suite exercise the shim's
 * `withUnsupportedSurfaceReplaced()` against that shadowing.
 */

/** Calls the stand-in methods below observed, in call order, as `[name, opts]`. */
export const upstreamCalls = []

class StandInFileSystemManager {
	// Representative of the supported async surface (`fileSystemManagerAPINames`
	// in `./index.js`): the shim must leave this one alone.
	writeFile(opts = {}) {
		upstreamCalls.push(['writeFile', opts])
		opts.success?.()
		opts.complete?.()
	}

	// Representative of an async method with no simulator container backend:
	// the shim must replace this with a `fail`-callback stub.
	unzip(opts = {}) {
		upstreamCalls.push(['unzip', opts])
		opts.success?.()
		opts.complete?.()
	}

	// Representative of a `*Sync` method: the shim must replace this with a
	// throwing stub, since the service thread's container bridge is async.
	writeFileSync(...args) {
		upstreamCalls.push(['writeFileSync', args])
	}
}

const standInMethodNames = Object
	.getOwnPropertyNames(StandInFileSystemManager.prototype)
	.filter(name => name !== 'constructor')

let instance

export function getFileSystemManager() {
	if (!instance) {
		const fsm = new StandInFileSystemManager()
		// Mirror upstream's own binding: copy prototype methods as bound own
		// properties so they shadow anything later assigned onto the prototype.
		for (const name of standInMethodNames) {
			fsm[name] = fsm[name].bind(fsm)
		}
		instance = fsm
	}
	return instance
}

// Real upstream derives this from `resolveVirtualFilePrefix()`
// (service/src/api/core/file/virtual-file-prefix.js); this stand-in only
// needs to satisfy the shim's re-export, so it hardcodes the same default
// scheme upstream falls back to when no override is configured.
export const VIRTUAL_FILE_PREFIX = 'difile://'
