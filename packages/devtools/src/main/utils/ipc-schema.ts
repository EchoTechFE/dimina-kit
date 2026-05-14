import type { z } from 'zod'

/**
 * Thrown by {@link validate} when an IPC payload fails its zod schema.
 *
 * Carries the channel name plus a compact list of failing zod paths so
 * the IpcRegistry wrapper can log a short, actionable summary without
 * dumping the full payload.
 */
export class IpcValidationError extends Error {
  readonly channel: string
  readonly paths: string[]

  constructor(channel: string, issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>) {
    const paths = issues.map((i) => i.path.map((p) => String(p)).join('.') || '<root>')
    super(`Invalid IPC arguments for ${channel}`)
    this.name = 'IpcValidationError'
    this.channel = channel
    this.paths = paths
  }
}

/**
 * Parse an IPC handler's argument tuple against a zod schema.
 *
 * On failure: warns to console with the channel name + issue list, then throws
 * an {@link IpcValidationError} so that:
 *  - `ipcMain.handle` invocations reject the renderer's invoke promise
 *    without leaking schema internals.
 *  - `ipcMain.on` listeners (wrapped by IpcRegistry.on) can recognise the
 *    error type and log a structured warning instead of letting the throw
 *    escape into Electron's event loop.
 */
export function validate<T extends z.ZodTypeAny>(
  channel: string,
  schema: T,
  args: unknown[],
): z.infer<T> {
  const r = schema.safeParse(args)
  if (!r.success) {
    console.warn('[ipc] schema reject', channel, r.error.issues)
    throw new IpcValidationError(channel, r.error.issues)
  }
  return r.data
}
