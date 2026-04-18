import { webContents } from 'electron'
import type { WorkbenchContext } from '../workbench-context.js'
import type { ElementRef } from './shared.js'

// ── Helpers ───────────────────────────────────────────────────────────

export function getSimulator(ctx: WorkbenchContext) {
  const simWcId = ctx.views.getSimulatorWebContentsId()
  if (!ctx.workspace.hasActiveSession() || simWcId == null) return null
  const sim = webContents.fromId(simWcId)
  if (!sim || sim.isDestroyed()) return null
  return sim
}

export async function evalInSim<T = unknown>(ctx: WorkbenchContext, expression: string): Promise<T> {
  const sim = getSimulator(ctx)
  if (!sim) throw new Error('Simulator not connected')
  return sim.executeJavaScript(expression) as Promise<T>
}

/** Build JS that locates an element by selector+index inside the active page iframe. */
export function buildElAccess(ref: ElementRef, varName = 'el'): string {
  const escaped = ref.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `const ${varName} = _doc.querySelectorAll('${escaped}')[${ref.index}]`
}

/** Wrap code to run inside the active page iframe (last iframe in the stack). */
export function inIframe(code: string): string {
  return `(() => {
    const iframes = document.querySelectorAll('iframe')
    const iframe = iframes[iframes.length - 1]
    if (!iframe || !iframe.contentDocument) throw new Error('No page iframe')
    const _doc = iframe.contentDocument
    return (function() { ${code} })()
  })()`
}
