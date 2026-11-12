import { writeSync } from 'node:fs'

/** Synchronous last-resort output avoids transport queues; exit before framework listeners print raw secrets or continue in a corrupt process. */
export function installFatalHandlers() {
  const fatal = (origin: string) => {
    try {
      writeSync(2, JSON.stringify({ level: 'fatal', time: new Date().toISOString(), service: 'fulfillment-tracker', environment: 'production', event: 'process.fatal', module: origin }) + '\n')
    } finally { process.exit(1) }
  }
  const exception = () => fatal('uncaughtException')
  const rejection = () => fatal('unhandledRejection')
  process.prependListener('uncaughtExceptionMonitor', exception)
  process.prependListener('unhandledRejection', rejection)
  return () => {
    process.removeListener('uncaughtExceptionMonitor', exception)
    process.removeListener('unhandledRejection', rejection)
  }
}
