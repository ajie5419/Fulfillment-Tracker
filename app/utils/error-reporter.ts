import { CLIENT_REPORT_LIMIT, CLIENT_REPORT_PATH, CLIENT_REPORT_WINDOW_MS, errorFingerprint, type ClientReport } from '#shared/telemetry'

export function createErrorReporter(send: (report: ClientReport) => Promise<unknown>, route: () => string, now = Date.now) {
  const seen = new Set<string>()
  let started = now()
  let count = 0
  return (kind: ClientReport['kind'], error: unknown, extra: Pick<ClientReport, 'requestId' | 'statusCode'> = {}) => {
    if (now() - started >= CLIENT_REPORT_WINDOW_MS) { started = now(); count = 0; seen.clear() }
    const record = error && typeof error === 'object' ? error as { name?: unknown; stack?: unknown; message?: unknown } : {}
    if (record.name === 'AbortError') return
    const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'NetworkError'].includes(String(record.name)) ? record.name as ClientReport['errorType'] : 'UnknownError'
    const fingerprint = errorFingerprint(String(record.stack ?? record.message ?? error))
    const key = `${fingerprint}:${extra.requestId ?? ''}`
    if (count >= CLIENT_REPORT_LIMIT || seen.has(key)) return
    count++; seen.add(key)
    // Telemetry is best effort: never retry, recursively report its own failures, or block the UI.
    try { void send({ kind, errorType: name, fingerprint, route: route(), ...extra }).catch(() => {}) }
    catch { /* Reporting must not replace the original application failure. */ }
  }
}

export const CLIENT_FAILURE_EVENT = 'ft:request-failed'
export function reportRequestFailure(error: unknown) {
  if (typeof window === 'undefined') return
  const source = error && typeof error === 'object' ? error as { response?: Response; name?: string } : {}
  if (source.name === 'AbortError') return
  const candidate = source.response?.headers?.get('x-request-id')
  const requestId = candidate && /^[a-f0-9-]{36}$/.test(candidate) ? candidate : undefined
  window.dispatchEvent(new CustomEvent(CLIENT_FAILURE_EVENT, { detail: { error, requestId, statusCode: source.response?.status ?? 0 } }))
}

export function sendClientReport(report: ClientReport) {
  return window.fetch(CLIENT_REPORT_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), keepalive: true, signal: AbortSignal.timeout(5000) })
}
