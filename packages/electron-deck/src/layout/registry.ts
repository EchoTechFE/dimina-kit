/**
 * Panel registry — pure in-memory map of panel descriptors. Pure TS.
 */
import type { Disposable, PanelDescriptor, PanelRegistry } from './types.js'

export function createPanelRegistry(): PanelRegistry {
	const map = new Map<string, PanelDescriptor>()
	return {
		register(p: PanelDescriptor): Disposable {
			map.set(p.id, p)
			return {
				dispose(): void {
					// Only drop if this exact descriptor is still registered, so a
					// re-register under the same id isn't undone by a stale handle.
					if (map.get(p.id) === p) map.delete(p.id)
				},
			}
		},
		get(id: string): PanelDescriptor | undefined {
			return map.get(id)
		},
		list(): readonly PanelDescriptor[] {
			return [...map.values()]
		},
	}
}
