import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, type NativeImage } from 'electron'

function getThumbnailDir(): string {
  return path.join(app.getPath('userData'), 'thumbnails')
}

function hashProjectPath(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
}

function getThumbnailPath(projectPath: string): string {
  return path.join(getThumbnailDir(), `${hashProjectPath(projectPath)}.png`)
}

export function saveThumbnail(projectPath: string, image: NativeImage): string | null {
  const png = image.toPNG()
  const dir = getThumbnailDir()
  fs.mkdirSync(dir, { recursive: true })
  const filePath = getThumbnailPath(projectPath)
  fs.writeFileSync(filePath, png)
  return `data:image/png;base64,${png.toString('base64')}`
}

export function loadThumbnail(projectPath: string): string | null {
  const filePath = getThumbnailPath(projectPath)
  try {
    const buf = fs.readFileSync(filePath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
