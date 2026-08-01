/**
 * Bridge for real Node built-ins in browser-bundled renderer documents.
 *
 * The simulator document runs with nodeIntegration OFF and its vite bundle
 * stubs `node:*` imports with truthy-but-empty objects, while its preload
 * (sandbox:false + contextIsolation:false — one shared JS world with the
 * page) has full Node access. The preload publishes the real modules on this
 * global; browser-side consumers (the vpath resolver, the FileSystemManager
 * backends) read them from here.
 *
 * Consumers MUST validate that the member they need is a function — never
 * trust truthiness, the vite stubs are truthy objects.
 */

export const NODE_BINDINGS_GLOBAL = '__diminaNodeBindings'

export interface DiminaNodeBindings {
	fs?: typeof import('node:fs')
	path?: typeof import('node:path')
	os?: typeof import('node:os')
	crypto?: typeof import('node:crypto')
	buffer?: typeof import('node:buffer')
}

export function getNodeBindings(): DiminaNodeBindings {
	const bag = (globalThis as Record<string, unknown>)[NODE_BINDINGS_GLOBAL]
	return (bag && typeof bag === 'object' ? bag : {}) as DiminaNodeBindings
}
