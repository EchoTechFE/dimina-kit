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
 */

class StandInFileSystemManager {}

let instance

export function getFileSystemManager() {
	if (!instance) {
		instance = new StandInFileSystemManager()
	}
	return instance
}
