// Re-export canonical CompileConfig from shared types
export type { CompileConfig } from '../../shared/types'

export interface Project {
  name: string
  path: string
  lastOpened?: string | null
}
