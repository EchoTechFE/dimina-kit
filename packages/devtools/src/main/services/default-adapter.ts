import type { CompilationAdapter } from '../../shared/types.js'
import path from 'path'
import { app } from 'electron'
import { simulatorDir } from '../utils/paths.js'

// Pin to devkit's public openProject signature so future drift (e.g. a new
// required field, a renamed `containerDir`) trips typecheck instead of
// silently passing the wrong shape at runtime.
type OpenProjectArgs = Parameters<typeof import('@dimina-kit/devkit').openProject>[0]

export interface DefaultAdapterOptions {
  /**
   * Absolute path to the jssdk runtime directory (`dimina-fe-container` build
   * output). Forwarded to devkit as `containerDir`. When omitted, devkit's
   * bundled container is used.
   */
  jssdkDir?: string
}

export function createDefaultAdapter(options: DefaultAdapterOptions = {}): CompilationAdapter {
  return {
    async openProject(opts) {
      const diminaKit = await import('@dimina-kit/devkit')
      const args: OpenProjectArgs = {
        outputDir: path.join(app.getPath('userData'), 'dimina-fe-output'),
        ...opts,
        simulatorDir,
        containerDir: options.jssdkDir,
      }
      return diminaKit.openProject(args)
    },
  }
}

export const defaultAdapter: CompilationAdapter = createDefaultAdapter()
