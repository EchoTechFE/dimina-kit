// Re-export canonical CompileConfig / ProjectType from shared types
export type { CompileConfig } from '../../shared/types'
import type { ProjectType } from '../../shared/types'

export type { ProjectType }

/** Single source for the category's Chinese display name — used by the sidebar rail, the project-list header, and the create-card label so they can't drift apart. */
export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  miniprogram: '小程序',
  minigame: '小游戏',
}

export interface Project {
  name: string
  path: string
  lastOpened?: string | null
  /** Absent on projects added before mini-game support — treat as 'miniprogram'. */
  type?: ProjectType
  /**
   * User-supplied icon for the project card. Absent means the card falls back
   * to the first character of `name`.
   */
  iconUrl?: string
}

/** The subset of a project record the edit dialog may change — `path` is the
 * record's identity and stays read-only there. */
export interface ProjectPatch {
  name?: string
  /** Empty string clears the icon and restores the name-initial fallback. */
  iconUrl?: string
}
