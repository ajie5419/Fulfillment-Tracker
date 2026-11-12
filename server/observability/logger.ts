import pino, { type DestinationStream, type Level } from 'pino'
import { logContext } from './context'

const FIELD_LIMIT = 256
const FIELDS = ['module', 'requestId', 'actorId', 'taskName', 'method', 'route', 'statusCode', 'durationMs', 'count', 'entityId', 'resultCode'] as const
type Fields = Partial<Record<typeof FIELDS[number], string | number>>

/** Only explicitly selected scalar fields may leave the application; never serialize errors or HTTP objects. */
export function createLogWriter(destination?: DestinationStream, level = process.env.LOG_LEVEL || 'info') {
  const logger = pino({
    level: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(level) ? level : 'info',
    base: { service: 'fulfillment-tracker', environment: process.env.NODE_ENV === 'production' ? 'production' : 'development' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    redact: ['password', 'token', 'authorization', 'cookie', 'body', 'headers'],
  }, destination ?? process.stdout)
  return (level: Level, event: string, fields: Fields = {}, error?: unknown) => {
    const source = { ...logContext.getStore(), ...fields }
    const safe: Record<string, string | number> = { event: event.replace(/[\r\n]/g, ' ').slice(0, FIELD_LIMIT) }
    for (const key of FIELDS) {
      const value = source[key]
      if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value
      else if (typeof value === 'string') safe[key] = value.replace(/[\r\n]/g, ' ').slice(0, FIELD_LIMIT)
    }
    if (error) {
      // Even Error.message and stack can contain SQL values, URLs, tokens and user input.
      safe.errorType = error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'UnknownError'
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (typeof code === 'string' && /^(P\d{4}|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND)$/.test(code)) safe.errorCode = code
    }
    logger[level](safe)
  }
}

export const logEvent = createLogWriter()
