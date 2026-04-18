import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const rendererDir = path.join(__dirname, '../../../dist/renderer')

export const defaultPreloadPath = path.join(__dirname, '../../preload/windows/simulator.js')

export function getRendererDir(): string {
  return rendererDir
}

export function getPreloadDir(): string {
  return path.join(__dirname, '../../preload')
}

export function getRendererHtml(filename: string): string {
  return path.join(rendererDir, filename)
}

