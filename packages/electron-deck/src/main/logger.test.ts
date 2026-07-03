import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, setLogLevel } from './logger.js'

describe('createLogger routing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setLogLevel('debug')
  })

  it('routes debug() to console.debug and no other console method', () => {
    const logger = createLogger('tag')
    logger.debug('hello')
    expect(console.debug).toHaveBeenCalledTimes(1)
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('routes info() to console.info and no other console method', () => {
    const logger = createLogger('tag')
    logger.info('hello')
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('routes warn() to console.warn and no other console method', () => {
    const logger = createLogger('tag')
    logger.warn('hello')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('routes error() to console.error and no other console method', () => {
    const logger = createLogger('tag')
    logger.error('hello')
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('createLogger message format', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setLogLevel('debug')
  })

  it('formats debug output as "<ISO timestamp> [DEBUG] [tag] message"', () => {
    createLogger('boot').debug('starting up')
    expect(console.debug).toHaveBeenCalledWith('2026-01-02T03:04:05.678Z [DEBUG] [boot] starting up')
  })

  it('formats info output as "<ISO timestamp> [INFO] [tag] message"', () => {
    createLogger('boot').info('ready')
    expect(console.info).toHaveBeenCalledWith('2026-01-02T03:04:05.678Z [INFO] [boot] ready')
  })

  it('formats warn output as "<ISO timestamp> [WARN] [tag] message"', () => {
    createLogger('boot').warn('slow response')
    expect(console.warn).toHaveBeenCalledWith('2026-01-02T03:04:05.678Z [WARN] [boot] slow response')
  })

  it('formats error output as "<ISO timestamp> [ERROR] [tag] message"', () => {
    createLogger('boot').error('crashed')
    expect(console.error).toHaveBeenCalledWith('2026-01-02T03:04:05.678Z [ERROR] [boot] crashed')
  })

  it('embeds the tag passed to createLogger, not a hardcoded placeholder', () => {
    createLogger('window-manager').info('resized')
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[window-manager] resized'),
    )
  })

  it('keeps different tags distinguishable in the formatted output', () => {
    createLogger('alpha').info('x')
    createLogger('beta').info('y')
    const calls = (console.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0]).toContain('[alpha]')
    expect(calls[1]).toContain('[beta]')
  })
})

describe('createLogger rest argument passthrough', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setLogLevel('debug')
  })

  it('forwards a single extra argument to console.debug unchanged', () => {
    const payload = { requestId: 42 }
    createLogger('net').debug('request failed', payload)
    expect(console.debug).toHaveBeenCalledTimes(1)
    expect(console.debug).toHaveBeenCalledWith(expect.any(String), payload)
  })

  it('forwards multiple extra arguments to console.error in call order', () => {
    const err = new Error('boom')
    createLogger('net').error('unhandled', err, { attempt: 3 }, 'retrying')
    expect(console.error).toHaveBeenCalledWith(expect.any(String), err, { attempt: 3 }, 'retrying')
  })

  it('does not fold rest arguments into the formatted message string', () => {
    createLogger('net').debug('event', { extra: true })
    const call = (console.debug as ReturnType<typeof vi.fn>).mock.calls.at(0) ?? []
    const message = call[0] as string
    expect(message.endsWith('event')).toBe(true)
    expect(message).not.toContain('true')
  })

  it('calls console.debug with zero rest arguments when none are given', () => {
    createLogger('net').debug('no payload here')
    const call = (console.debug as ReturnType<typeof vi.fn>).mock.calls.at(0) ?? []
    expect(call).toHaveLength(1)
  })
})

describe('setLogLevel filtering', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setLogLevel('debug')
  })

  it('suppresses debug and info entirely once the level is raised to warn', () => {
    setLogLevel('warn')
    const logger = createLogger('svc')
    logger.debug('d')
    logger.info('i')
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
  })

  it('still emits warn and error once the level is raised to warn', () => {
    setLogLevel('warn')
    const logger = createLogger('svc')
    logger.warn('w')
    logger.error('e')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('suppresses every level except error once the level is raised to error', () => {
    setLogLevel('error')
    const logger = createLogger('svc')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('logs every level again once setLogLevel restores debug', () => {
    setLogLevel('error')
    setLogLevel('debug')
    const logger = createLogger('svc')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(console.debug).toHaveBeenCalledTimes(1)
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('applies a level change made after createLogger() to that already-created instance', () => {
    const logger = createLogger('svc')
    logger.debug('before raise, should log')
    expect(console.debug).toHaveBeenCalledTimes(1)

    setLogLevel('warn')
    logger.debug('after raise, must not log')
    expect(console.debug).toHaveBeenCalledTimes(1)

    logger.warn('after raise, should log')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('applies a level lowered back down to an already-created instance', () => {
    const logger = createLogger('svc')
    setLogLevel('error')
    logger.info('suppressed while at error level')
    expect(console.info).not.toHaveBeenCalled()

    setLogLevel('debug')
    logger.info('audible again after lowering back')
    expect(console.info).toHaveBeenCalledTimes(1)
  })

  it('applies the current level to loggers created after the level change, not the level at creation', () => {
    setLogLevel('warn')
    const lateLogger = createLogger('late')
    lateLogger.info('should stay suppressed under warn')
    expect(console.info).not.toHaveBeenCalled()
  })
})
