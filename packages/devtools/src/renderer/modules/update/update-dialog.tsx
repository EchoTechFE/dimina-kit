import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { invokeStrict, on as ipcOn } from '@/shared/api/ipc-transport'
import { UpdateChannel } from '../../../shared/ipc-channels.js'

// Update dialog uses `invokeStrict` (rejects on error) so a failed download
// surfaces as an "error" stage instead of being silently swallowed by the
// default invoke wrapper. `ipcOn` is the renderer-side subscribe helper that
// funnels through the same preload bridge as every other facade in this
// folder, keeping update-dialog inside the typed transport boundary that
// the renderer eslint rule enforces.

interface UpdateInfo {
  version: string
  downloadUrl: string
  releaseNotes?: string
  mandatory?: boolean
}

type Stage = 'prompt' | 'downloading' | 'ready' | 'error'

export function UpdateDialog() {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [stage, setStage] = useState<Stage>('prompt')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    return ipcOn<[UpdateInfo]>(UpdateChannel.Available, (updateInfo) => {
      setInfo(updateInfo)
      setStage('prompt')
      setProgress(0)
      setError('')
      setOpen(true)
    })
  }, [])

  useEffect(() => {
    return ipcOn<[{ percent: number }]>(UpdateChannel.DownloadProgress, (data) => {
      setProgress(Math.round(data.percent))
    })
  }, [])

  const handleDownload = useCallback(async () => {
    setStage('downloading')
    setProgress(0)
    try {
      const result = await invokeStrict<{
        success: boolean
        error?: string
      }>(UpdateChannel.Download)
      if (result.success) {
        setStage('ready')
      } else {
        setError(result.error || 'Download failed')
        setStage('error')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage('error')
    }
  }, [])

  const handleInstall = useCallback(() => {
    void invokeStrict(UpdateChannel.Install).catch((err: unknown) => {
      console.warn('[update] install failed:', err)
    })
  }, [])

  const handleClose = useCallback(() => {
    if (info?.mandatory && stage !== 'ready') return
    setOpen(false)
  }, [info, stage])

  if (!info) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && info?.mandatory && stage !== 'ready') return
        setOpen(v)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === 'ready' ? 'Ready to Install' : 'Update Available'}
          </DialogTitle>
          <DialogDescription>
            {stage === 'prompt' && `New version ${info.version} is available.`}
            {stage === 'downloading' && `Downloading... ${progress}%`}
            {stage === 'ready' && 'Download complete. Click install to restart and apply the update.'}
            {stage === 'error' && `Download failed: ${error}`}
          </DialogDescription>
        </DialogHeader>

        {info.releaseNotes && stage === 'prompt' && (
          <div className="max-h-40 overflow-y-auto rounded border border-border bg-surface-2 p-3 text-xs text-text-secondary whitespace-pre-wrap">
            {info.releaseNotes}
          </div>
        )}

        {stage === 'downloading' && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        <DialogFooter>
          {stage === 'prompt' && (
            <>
              {!info.mandatory && (
                <Button variant="outline" onClick={handleClose}>
                  Later
                </Button>
              )}
              <Button onClick={handleDownload}>Download</Button>
            </>
          )}
          {stage === 'ready' && (
            <Button onClick={handleInstall}>Install & Restart</Button>
          )}
          {stage === 'error' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Close
              </Button>
              <Button onClick={handleDownload}>Retry</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
