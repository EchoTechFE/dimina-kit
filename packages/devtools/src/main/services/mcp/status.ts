export interface McpRuntimeStatus {
  running: boolean
  port: number | null
  error: string | null
}

let status: McpRuntimeStatus = { running: false, port: null, error: null }

export function getMcpStatus(): McpRuntimeStatus {
  return { ...status }
}

export function recordMcpStarted(port: number): void {
  status = { running: true, port, error: null }
}

export function recordMcpFailed(error: string): void {
  status = { running: false, port: null, error }
}

export function recordMcpStopped(): void {
  status = { running: false, port: null, error: null }
}
