/**
 * Adapts the compile-mode half of `ProjectsProvider` — where every method is
 * optional — onto the four methods `WorkspaceService` always exposes.
 *
 * A host may implement the mode list, only the older single-config pair, or
 * neither. Each direction degrades on its own so a partial host still gets the
 * behavior it can support instead of an exception.
 */

import type { CompileConfig, CompileModes } from '../../../shared/types.js'
import {
  compileConfigToModes,
  emptyCompileModes,
  resolveCompileConfig,
} from '../../../shared/compile-modes.js'
import type { ProjectsProvider } from '../projects/types.js'
import { DEFAULT_COMPILE_CONFIG } from '../projects/types.js'

export interface CompileModeAdapter {
  getCompileConfig(projectPath: string): Promise<CompileConfig>
  saveCompileConfig(projectPath: string, config: CompileConfig): Promise<void>
  getCompileModes(projectPath: string): Promise<CompileModes>
  saveCompileModes(projectPath: string, modes: CompileModes): Promise<void>
}

export function createCompileModeAdapter(provider: ProjectsProvider): CompileModeAdapter {
  return {
    // Prefer the host's own resolver: only it can substitute the project's
    // entry page for 普通编译's empty start page. Deriving from the mode list
    // is the fallback for hosts that implement modes but not this.
    async getCompileConfig(projectPath) {
      if (provider.getCompileConfig) {
        return (await provider.getCompileConfig(projectPath)) as CompileConfig
      }
      if (provider.getCompileModes) {
        return resolveCompileConfig(await provider.getCompileModes(projectPath))
      }
      return DEFAULT_COMPILE_CONFIG as CompileConfig
    },

    async saveCompileConfig(projectPath, config) {
      if (provider.saveCompileConfig) {
        await provider.saveCompileConfig(projectPath, config)
      }
      // No persistence when the host opts out; the renderer's edits then
      // do not survive a reload, matching the documented contract.
    },

    // Mirror of saveCompileModes' degradation: a host still on the single
    // config gets it projected into one selected mode, so its start page and
    // params actually launch instead of being read as 普通编译 and dropped.
    async getCompileModes(projectPath) {
      if (provider.getCompileModes) {
        return await provider.getCompileModes(projectPath)
      }
      if (provider.getCompileConfig) {
        return compileConfigToModes((await provider.getCompileConfig(projectPath)) as CompileConfig)
      }
      return emptyCompileModes()
    },

    async saveCompileModes(projectPath, modes) {
      if (provider.saveCompileModes) {
        await provider.saveCompileModes(projectPath, modes)
        return
      }
      // Degrade for a host still on the single-config setter: the selection
      // still takes effect, it just cannot store the named list.
      if (provider.saveCompileConfig) {
        await provider.saveCompileConfig(projectPath, resolveCompileConfig(modes))
      }
    },
  }
}
