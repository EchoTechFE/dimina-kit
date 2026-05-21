import type { CompilationAdapter } from '../../shared/types.js'
import type { OpenProjectOptions } from '@dimina-kit/devkit'
import path from 'path'
import { app } from 'electron'
import { simulatorDir } from '../utils/paths.js'

export const defaultAdapter: CompilationAdapter = {
  async openProject(opts) {
    const diminaKit = await import('@dimina-kit/devkit')
    const openProjectOpts: OpenProjectOptions = {
      outputDir: path.join(app.getPath('userData'), 'dimina-fe-output'),
      ...opts,
      simulatorDir,
    }
    return diminaKit.openProject(openProjectOpts)
  },
}
