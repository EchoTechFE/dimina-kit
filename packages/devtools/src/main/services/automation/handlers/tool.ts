import type { Handler } from '../shared.js'

export const toolHandlers: Record<string, Handler> = {}

// -- Tool domain --

toolHandlers['Tool.getInfo'] = async () => ({ SDKVersion: '2.7.3' })

toolHandlers['Tool.close'] = async (ctx) => {
  await ctx.workspace.closeProject()
  return {}
}
