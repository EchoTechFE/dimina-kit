type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
}

let currentLevel: LogLevel = 'debug'

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]
}

function formatMessage(level: LogLevel, tag: string, message: string): string {
  const ts = new Date().toISOString()
  return `${ts} ${LEVEL_PREFIX[level]} [${tag}] ${message}`
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * Create a tagged logger for a specific module.
 * All output goes to console with structured prefix.
 */
export function createLogger(tag: string): Logger {
  return {
    debug(message: string, ...args: unknown[]) {
      if (shouldLog('debug')) console.debug(formatMessage('debug', tag, message), ...args)
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('info')) console.info(formatMessage('info', tag, message), ...args)
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('warn')) console.warn(formatMessage('warn', tag, message), ...args)
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog('error')) console.error(formatMessage('error', tag, message), ...args)
    },
  }
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}
