// Re-export canonical types from shared types
export type { CompileConfig, LaunchConfig } from '../../shared/types'

export interface Project {
  name: string
  path: string
  lastOpened?: string | null
}
