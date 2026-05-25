export const callback = {
	store(_fn: unknown, _keep?: boolean, evtId = 'callback'): string {
		return evtId
	},
	remove(_evtId?: string): void {},
}
