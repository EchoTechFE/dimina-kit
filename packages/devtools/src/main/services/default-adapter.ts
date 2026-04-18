import type { CompilationAdapter } from '../../shared/types.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const simulatorDir = path.resolve(__dirname, '../../simulator')

type OpenProjectArgs = {
  projectPath: string
  port?: number
  sourcemap?: boolean
  simulatorDir?: string
  onRebuild?: () => void
  onBuildError?: (err: unknown) => void
}

export const defaultAdapter: CompilationAdapter = {
  async openProject(opts) {
    const diminaKit = await import('@dimina-kit/devkit')
    const openProject = diminaKit.openProject as (opts: OpenProjectArgs) => ReturnType<typeof diminaKit.openProject>
    return openProject({ ...opts, simulatorDir })
  },
}
