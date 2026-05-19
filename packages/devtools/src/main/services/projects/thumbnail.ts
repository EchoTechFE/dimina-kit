import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

function getThumbnailDir(): string {
  return path.join(app.getPath('userData'), 'thumbnails')
}

function hashProjectPath(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
}

function getThumbnailPath(projectPath: string): string {
  return path.join(getThumbnailDir(), `${hashProjectPath(projectPath)}.png`)
}

const DATA_URL_PNG_PREFIX = 'data:image/png;base64,'

/**
 * Persist a data-URL screenshot for the local default provider. Silently
 * drops the call when the URL isn't the expected PNG base64 form — the
 * provider contract documents this as best-effort.
 */
export function saveThumbnailFromDataUrl(
  projectPath: string,
  imageDataUrl: string,
): void {
  if (!imageDataUrl.startsWith(DATA_URL_PNG_PREFIX)) return
  const png = Buffer.from(imageDataUrl.slice(DATA_URL_PNG_PREFIX.length), 'base64')
  fs.mkdirSync(getThumbnailDir(), { recursive: true })
  fs.writeFileSync(getThumbnailPath(projectPath), png)
}

export function loadThumbnail(projectPath: string): string | null {
  const filePath = getThumbnailPath(projectPath)
  try {
    const buf = fs.readFileSync(filePath)
    return `${DATA_URL_PNG_PREFIX}${buf.toString('base64')}`
  } catch {
    return null
  }
}
