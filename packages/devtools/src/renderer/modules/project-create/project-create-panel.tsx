import { useEffect, useState } from 'react'
import {
  notifyOverlayReady,
  onProjectCreateInit,
  submitProjectCreate,
  cancelProjectCreate,
  chooseProjectDirectory,
  type ProjectCreateShowPayload,
} from '@/shared/api'
import { ProjectCreateDialog } from '@/shared/components/project-create-dialog'

/**
 * Thin stateful shell for the top-tier native project-create overlay surface.
 * `project-create-dialog.tsx` stays a pure props/callback component; this
 * mounts it against the render request main pushes after `showProjectCreateDialog`,
 * and relays submit/cancel back to main.tsx's existing scaffold flow.
 */
export default function ProjectCreatePanel() {
  const [request, setRequest] = useState<ProjectCreateShowPayload | null>(null)

  useEffect(() => {
    const off = onProjectCreateInit(setRequest)
    notifyOverlayReady()
    return off
  }, [])

  if (!request) return null

  // `open` below is a literal, never toggled — ProjectCreateDialog's own
  // `[open]`-keyed field reset only fires on this component's first mount.
  // Dropping `request` back to null on cancel/submit unmounts it, so the
  // NEXT show (a fresh `request` pushed from main) mounts a brand-new
  // instance instead of reusing one still holding this session's input.
  function handleCancel() {
    setRequest(null)
    cancelProjectCreate()
  }

  function handleSubmit(input: Parameters<typeof submitProjectCreate>[0]) {
    setRequest(null)
    submitProjectCreate(input)
  }

  return (
    <ProjectCreateDialog
      open
      templates={request.templates}
      defaultBaseDir={request.defaultBaseDir}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
      onBrowse={chooseProjectDirectory}
    />
  )
}
