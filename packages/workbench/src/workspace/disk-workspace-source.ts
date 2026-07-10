/**
 * Disk-backed workspace source: mirror a real on-disk dimina project into the
 * `file:///workspace` memfs over the COI `/__fs/*` bridge and flush saves back
 * to disk. This is the devtools editor's file source — edits round-trip to the
 * actual project, driving the live-preview rebuild.
 */
import { WORKSPACE_FILE_ROOT, mirrorDiskToFileWorkspace, flushFileWorkspaceSaveToDisk } from '../file-workspace'
import type { WorkspaceSource } from './types'

export interface DiskMirrorOptions {
  /** Base URL of the COI server exposing `/__fs/*` (usually `location.origin + '/'`). */
  fsBaseUrl: string
}

export function diskMirrorSource({ fsBaseUrl }: DiskMirrorOptions): WorkspaceSource {
  return {
    folderUri: WORKSPACE_FILE_ROOT,
    populate: () => mirrorDiskToFileWorkspace(fsBaseUrl),
    onSave: (uri, content) => flushFileWorkspaceSaveToDisk(fsBaseUrl, uri, content),
  }
}
