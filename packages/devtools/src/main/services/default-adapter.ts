import type { CompilationAdapter } from '../../shared/types.js'
import path from 'path'
import { fileURLToPath } from 'url'
import { app } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const simulatorDir = path.resolve(__dirname, '../../simulator')
// Devtools ships its own pre-built container under <app>/container/.
// dist/main/services/default-adapter.js -> ../../../container
const containerDir = path.resolve(__dirname, '../../../container')

type OpenProjectArgs = {
  projectPath: string
  port?: number
  sourcemap?: boolean
  simulatorDir?: string
  containerDir?: string
  outputDir?: string
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
      containerDir,
    })
  },
}
