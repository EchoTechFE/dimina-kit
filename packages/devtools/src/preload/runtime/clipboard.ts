import { clipboard } from 'electron'
import { exposeOnMainWorld } from '../shared/expose.js'

export interface DiminaClipboardBridge {
	readText(): string
	writeText(text: string): void
}

function buildBridge(): DiminaClipboardBridge {
	return {
		readText: () => clipboard.readText(),
		writeText: (text: string) => clipboard.writeText(text),
	}
}

export function installClipboardBridge(): () => void {
	return exposeOnMainWorld('__diminaClipboard', buildBridge())
}
