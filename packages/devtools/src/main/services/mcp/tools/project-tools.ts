/**
 * MCP project lifecycle tools: open (launch the mini-program in the
 * simulator), close, query compile status, await the compile settling, and
 * pull compile logs incrementally.
 *
 * `project_open` does NOT call `workspace.openProject` directly: the renderer
 * owns the open path (mounting ProjectRuntime is what compiles AND attaches
 * the simulator), so the tool pushes a `window:openProject` event and then
 * awaits the session-status store — the same main-process authority the
 * notifier tap feeds from the renderer-driven compile.
 */

import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CompileLogBuffer } from '../../workspace/compile-log-buffer.js'
import type {
  SessionStatusSnapshot,
  SessionStatusStore,
} from '../../workspace/session-status-store.js'
import type { McpOpenedProject, McpProjectStatusSource } from '../opened-project.js'

/**
 * Narrow structural slice of WorkspaceService the project tools need.
 * Structural (not a Pick of the real interface) so tests can hand in a
 * plain object and this module never imports workbench-context.
 */
export interface McpProjectWorkspace {
  validateProjectDir(dirPath: string): Promise<string | null>
  hasProject(dirPath: string): Promise<boolean>
  addProject(dirPath: string): Promise<{ name: string; path: string }>
  listProjects(): Promise<{ name: string; path: string }[]>
  closeProject(): Promise<void>
  getProjectPath(): string
  hasActiveSession(): boolean
}

/**
 * One project window's surfaces, resolved together. A project lives in its own
 * window with its own workspace, status store and log buffer, so a tool call
 * that read them one by one could mix two projects: every surface here comes
 * from the same window at the same instant.
 */
export interface McpProjectTarget {
  workspace: McpProjectWorkspace
  sessionStatus: SessionStatusStore
  compileLogs: CompileLogBuffer
  /** Close this target's project window; a no-op when it has none. */
  closeWindow(): void
}

/** Everything `registerProjectTools` needs, assembled by app bootstrap. */
export interface McpProjectHost {
  /**
   * The project window a call arriving now is aimed at. Taken ONCE per tool
   * call and held for its whole lifetime: tools await compiles and teardowns,
   * and the user is free to focus another project meanwhile — re-resolving
   * afterwards would report one project's compile as another's, or close the
   * window they just moved to.
   */
  currentProject(): McpProjectTarget
  /**
   * Push the renderer to open the project (the user-click-equivalent path) and
   * resolve with the window it landed in. A project lives in its own window
   * with its own status store, so the caller can only await the right compile
   * by holding that window — the window active when the call arrived is a
   * different project.
   */
  requestOpenInUi(project: { name: string; path: string }): Promise<McpOpenedProject>
}

const DEFAULT_OPEN_TIMEOUT_MS = 180_000
const DEFAULT_WAIT_TIMEOUT_MS = 60_000

function text(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function errorText(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

/**
 * Public phase: a settled store snapshot with no live session means no
 * project is open ('idle'), while 'error'/'compiling' pass through as-is —
 * `hasActiveSession()` is false during a compile and after a failed open,
 * so those phases are the truthful answer even without a session.
 */
function publicPhase(
  snapshot: SessionStatusSnapshot,
  sessionActive: boolean,
): SessionStatusSnapshot['phase'] {
  if (!sessionActive && snapshot.phase === 'ready') return 'idle'
  return snapshot.phase
}

/** Reads one window's own status: the pinned target, or the window an open landed in. */
function statusPayload(source: McpProjectStatusSource) {
  const snapshot = source.sessionStatus.get()
  const sessionActive = source.workspace.hasActiveSession()
  return {
    phase: publicPhase(snapshot, sessionActive),
    message: snapshot.message,
    projectPath: source.workspace.getProjectPath(),
    sessionActive,
    watcherAlive: snapshot.watcherAlive,
    updatedAt: snapshot.updatedAt,
    generation: snapshot.generation,
  }
}

export function registerProjectTools(server: McpServer, host: McpProjectHost): void {
  server.tool(
    'project_open',
    'Open a mini-program project: registers the directory if needed, launches it in the simulator (compile + attach), and waits until the compile settles. Returns the settled status; on compile error, pull stderr via compile_logs.',
    {
      path: z.string().describe('Absolute path to the mini-program project directory'),
      timeoutMs: z.number().optional().default(DEFAULT_OPEN_TIMEOUT_MS)
        .describe('Max time to wait for the compile to settle'),
    },
    async ({ path: rawPath, timeoutMs }) => {
      const target = host.currentProject()
      const dir = path.resolve(rawPath)

      // Already open and settled: report instead of re-triggering a compile.
      const current = target.sessionStatus.get()
      if (target.workspace.getProjectPath() === dir
        && target.workspace.hasActiveSession()
        && current.phase === 'ready') {
        return text({ ...statusPayload(target), note: 'project already open' })
      }

      const invalid = await target.workspace.validateProjectDir(dir)
      if (invalid) return errorText(invalid)

      let project: { name: string; path: string }
      if (await target.workspace.hasProject(dir)) {
        const known = (await target.workspace.listProjects()).find((p) => p.path === dir)
        project = known ?? { name: path.basename(dir), path: dir }
      } else {
        project = await target.workspace.addProject(dir)
      }

      // The open hands back the window it landed in; that window's store is the
      // only place this compile is reported, and its `afterGeneration` keeps a
      // state that predates the open from being read as this open's result.
      let opened: McpOpenedProject
      let settled: SessionStatusSnapshot
      try {
        opened = await host.requestOpenInUi({ name: project.name, path: project.path })
        settled = await opened.sessionStatus.waitForSettled({
          afterGeneration: opened.afterGeneration,
          timeoutMs,
        })
      } catch (err) {
        return errorText(err instanceof Error ? err.message : String(err))
      }

      if (settled.phase === 'error') {
        return errorText(
          `compile failed: ${settled.message} — call compile_logs (stream: "stderr") for details`,
        )
      }
      return text(statusPayload(opened))
    },
  )

  server.tool(
    'project_close',
    'Close the currently open project session and return the workbench to the project list.',
    {},
    async () => {
      // Held across the await: `closeProject()` yields, and a window the user
      // focuses while it runs must not become the window this close takes down.
      const target = host.currentProject()
      if (!target.workspace.getProjectPath() && !target.workspace.hasActiveSession()) {
        return text({ closed: false, note: 'no project is open' })
      }
      await target.workspace.closeProject()
      target.closeWindow()
      return text({ closed: true })
    },
  )

  server.tool(
    'project_status',
    'Query the current project compile status (phase: idle | compiling | ready | error). Includes `generation` — pass it to project_wait_ready to await the NEXT settled state.',
    {},
    async () => text(statusPayload(host.currentProject())),
  )

  server.tool(
    'project_wait_ready',
    'Wait until the compile pipeline settles (phase leaves "compiling"). Watcher rebuilds emit no "compiling" phase, so to await a rebuild after editing files pass the `generation` from a prior project_status.',
    {
      afterGeneration: z.number().optional()
        .describe('Only accept states recorded after this generation (from project_status). Omit to accept the current state when already settled.'),
      timeoutMs: z.number().optional().default(DEFAULT_WAIT_TIMEOUT_MS)
        .describe('Max time to wait'),
    },
    async ({ afterGeneration, timeoutMs }) => {
      // Held across the wait: the state this call reports must come from the
      // window it was aimed at, whichever window is focused when it settles.
      const target = host.currentProject()
      try {
        await target.sessionStatus.waitForSettled({ afterGeneration, timeoutMs })
      } catch (err) {
        return errorText(err instanceof Error ? err.message : String(err))
      }
      return text(statusPayload(target))
    },
  )

  server.tool(
    'compile_logs',
    'Pull compile log lines incrementally. Pass the previous call\'s nextCursor as `cursor` to receive only new lines. The buffer resets on each fresh project open; watcher rebuilds append to the same timeline.',
    {
      cursor: z.number().optional().default(0)
        .describe('Return only lines after this cursor (0 = from the start of the buffer)'),
      limit: z.number().optional().default(100).describe('Max lines to return'),
      stream: z.enum(['stdout', 'stderr']).optional()
        .describe('Only lines from this stream (stderr carries compile errors)'),
    },
    async ({ cursor, limit, stream }) => {
      const read = host.currentProject().compileLogs.read({ afterSeq: cursor, limit, stream })
      return text(read)
    },
  )
}
