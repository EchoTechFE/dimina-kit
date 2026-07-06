/**
 * Type declaration for agent-tools.js (runtime stays plain JS — see
 * client.d.ts for why this file exists). `fs` is typed loosely: every real
 * caller passes an already-`any`-typed ProjectFsClient handle, so nothing is
 * gained by re-deriving its shape here.
 */
export interface AgentTool {
  name: string
  description: string
  inputSchema: unknown
  execute: (...args: any[]) => unknown
  dangerous?: boolean
}

export declare function createAgentTools(fs: any): {
  tools: AgentTool[]
  byName: Record<string, AgentTool>
  beginTurn(opts?: Record<string, unknown>): Promise<{ turnId: string } & Record<string, unknown>>
  endTurn(): Promise<unknown>
  readonly activeTurn: string | null
}
