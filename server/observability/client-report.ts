import { createError, getHeader, getRequestIP, getRequestWebStream, type H3Event } from 'h3'
import { clientReportSchema, CLIENT_REPORT_LIMIT, CLIENT_REPORT_MAX_BYTES, CLIENT_REPORT_WINDOW_MS } from '../../shared/telemetry'
import { logEvent } from './logger'

const MAX_KEYS = 5000
const GLOBAL_LIMIT = 120
const BODY_TIMEOUT_MS = 3000
export function createReportLimiter(now = Date.now) {
  const clients = new Map<string, number>()
  let start = now(), total = 0
  return (key: string) => {
    if (now() - start >= CLIENT_REPORT_WINDOW_MS) { clients.clear(); start = now(); total = 0 }
    const count = clients.get(key) ?? 0
    if (total >= GLOBAL_LIMIT || count >= CLIENT_REPORT_LIMIT || (!clients.has(key) && clients.size >= MAX_KEYS)) return false
    clients.set(key, count + 1); total++
    return true
  }
}
const admit = createReportLimiter()

/** Public before login, but bounded and same-origin; reports are untrusted client evidence, never server exception counts. */
export async function acceptClientReport(event: H3Event) {
  const origin = getHeader(event, 'origin')
  let sameOrigin = false
  try { sameOrigin = !!origin && new URL(origin).host === getHeader(event, 'host') } catch { /* Invalid origins are rejected below. */ }
  if (!sameOrigin || !getHeader(event, 'content-type')?.startsWith('application/json')) throw createError({ statusCode: 403 })
  // Do not trust X-Forwarded-For without an explicitly configured proxy trust boundary.
  if (!admit(getRequestIP(event) ?? 'unknown')) throw createError({ statusCode: 429 })
  const stream = getRequestWebStream(event)
  if (!stream) throw createError({ statusCode: 400 })
  const reader = stream.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(createError({ statusCode: 408 })), BODY_TIMEOUT_MS) })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired])
      if (done) break
      bytes += value.byteLength
      if (bytes > CLIENT_REPORT_MAX_BYTES) throw createError({ statusCode: 413 })
      chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw createError({ statusCode: 400 }) }
  const parsed = clientReportSchema.safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400 })
  const r = parsed.data
  logEvent('warn', 'client.reported', { module: r.kind, route: r.route, clientFingerprint: r.fingerprint, clientErrorType: r.errorType, relatedRequestId: r.requestId, statusCode: r.statusCode })
  return { accepted: true }
}
