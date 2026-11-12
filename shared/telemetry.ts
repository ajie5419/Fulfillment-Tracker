import { z } from 'zod'

export const CLIENT_REPORT_PATH = '/api/telemetry/client'
export const CLIENT_REPORT_LIMIT = 20
export const CLIENT_REPORT_WINDOW_MS = 60_000
export const CLIENT_REPORT_MAX_BYTES = 4096
export const clientReportSchema = z.object({
  kind: z.enum(['vue', 'app', 'javascript', 'promise', 'resource', 'request']),
  errorType: z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'NetworkError', 'UnknownError']),
  fingerprint: z.string().regex(/^[a-f0-9]{8}$/),
  route: z.string().max(160).regex(/^[a-zA-Z0-9_/:.[\]-]*$/),
  requestId: z.string().uuid().optional(),
  statusCode: z.number().int().min(0).max(599).optional(),
}).strict()
export type ClientReport = z.infer<typeof clientReportSchema>

/** Hash diagnostics locally; raw exception messages and stacks never leave the browser. */
export function errorFingerprint(value: string): string {
  let hash = 2166136261
  for (const c of value.slice(0, 8192)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
