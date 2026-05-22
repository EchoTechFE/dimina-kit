import type { WorkbenchContext } from '../workbench-context.js'
import type { ElementRef } from './shared.js'

// ── Helpers ───────────────────────────────────────────────────────────

export function getSimulator(ctx: WorkbenchContext) {
  if (!ctx.workspace.hasActiveSession()) return null
  return ctx.views.getSimulatorWebContents()
}

export async function evalInSim<T = unknown>(ctx: WorkbenchContext, expression: string): Promise<T> {
  const sim = getSimulator(ctx)
  if (!sim) throw new Error('Simulator not connected')
  return sim.executeJavaScript(expression) as Promise<T>
}

/** Build JS that locates an element by selector+index inside the active page iframe. */
export function buildElAccess(ref: ElementRef, varName = 'el'): string {
  return `const ${varName} = _doc.querySelectorAll(${JSON.stringify(ref.selector)})[${ref.index}]`
}

/** Run `body` inside the active page iframe with `varName` bound to the element at `ref`. */
export function evalInElement<T = unknown>(
  ctx: WorkbenchContext,
  ref: ElementRef,
  body: string,
  varName = 'el',
): Promise<T> {
  return evalInSim<T>(ctx, inIframe(`${buildElAccess(ref, varName)}\n${body}`))
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
