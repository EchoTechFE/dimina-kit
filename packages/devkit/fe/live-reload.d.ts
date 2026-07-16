// Declaration for the plain-JS live-reload server module so TS consumers (unit
// tests, `openProject`) get types without pulling `fe/` into the TS program.
export function refreshStylesheets(doc: Document): void
export function createLiveReload(app: {
	get: (path: string, handler: (req: unknown, res: unknown) => void) => void
}): {
	reload: () => void
	reloadStyles: () => void
	injectScript: (containerDir: string) => (req: unknown, res: unknown) => void
}
