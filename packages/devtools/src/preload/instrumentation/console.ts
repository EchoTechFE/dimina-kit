import { SimulatorChannel } from '../../shared/ipc-channels.js'
import { sendToHost, safeSerialize } from '../runtime/host.js'

type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug'

export function installConsoleInstrumentation(): () => void {
  const consoleRef = console as unknown as Record<string, (...args: unknown[]) => void>
  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>()
  const levels: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug']

  for (const level of levels) {
    const original = consoleRef[level]?.bind(console)
    if (!original) continue
    originals.set(level, original)
    consoleRef[level] = (...args: unknown[]) => {
      original(...args)
      sendToHost(SimulatorChannel.Console, {
        source: 'container',
        level,
        args: args.map(safeSerialize),
        ts: Date.now(),
      })
    }
  }

  const handleError = (event: ErrorEvent) => {
    sendToHost(SimulatorChannel.Console, {
      source: 'container',
      level: 'error',
      args: [{
        message: event.message,
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      }],
      ts: Date.now(),
    })
  }

  const handleRejection = (event: PromiseRejectionEvent) => {
    sendToHost(SimulatorChannel.Console, {
      source: 'container',
      level: 'error',
      args: [{ message: 'Unhandled Promise Rejection', reason: String(event.reason) }],
      ts: Date.now(),
    })
  }

  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleRejection)

  return () => {
    for (const [level, original] of originals) {
      consoleRef[level] = original
    }
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}
