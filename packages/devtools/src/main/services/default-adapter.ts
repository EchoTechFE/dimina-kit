import type { CompilationAdapter } from '../../shared/types.js'
import path from 'path'
import { app } from 'electron'
import { simulatorDir } from '../utils/paths.js'

type OpenProjectArgs = {
  projectPath: string
  port?: number
  sourcemap?: boolean
  simulatorDir?: string
  outputDir?: string
  watch?: boolean
  onRebuild?: () => void
  onBuildError?: (err: unknown) => void
}

export const defaultAdapter: CompilationAdapter = {
  async openProject(opts) {
    const diminaKit = await import('@dimina-kit/devkit')
    const openProject = diminaKit.openProject as (opts: OpenProjectArgs) => ReturnType<typeof diminaKit.openProject>
    return openProject({
      outputDir: path.join(app.getPath('userData'), 'dimina-fe-output'),
      ...opts,
      simulatorDir,
    })
  },
}
