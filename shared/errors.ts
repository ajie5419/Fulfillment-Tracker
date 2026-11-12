/** Domain errors may omit a code internally; the HTTP boundary always supplies one. */
export const BUSINESS_ERROR_CODES = ['NOT_FOUND', 'CONFLICT', 'VALIDATION', 'INTERNAL', 'UNAUTHORIZED', 'FORBIDDEN', 'METHOD_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'UNAVAILABLE', 'REQUEST_FAILED'] as const
export type BusinessErrorCode = typeof BUSINESS_ERROR_CODES[number]

/** INTERNAL 不覆盖原来的 HTTP 状态（例如 QMS 不可用仍为 503）。 */
export const BUSINESS_ERROR_HTTP: Partial<Record<BusinessErrorCode, { statusCode: number; statusMessage: string }>> = {
  NOT_FOUND: { statusCode: 404, statusMessage: 'Not Found' },
  CONFLICT: { statusCode: 409, statusMessage: 'Conflict' },
  VALIDATION: { statusCode: 400, statusMessage: 'Bad Request' },
  UNAUTHORIZED: { statusCode: 401, statusMessage: 'Unauthorized' },
  FORBIDDEN: { statusCode: 403, statusMessage: 'Forbidden' },
  METHOD_NOT_ALLOWED: { statusCode: 405, statusMessage: 'Method Not Allowed' },
  PAYLOAD_TOO_LARGE: { statusCode: 413, statusMessage: 'Payload Too Large' },
  RATE_LIMITED: { statusCode: 429, statusMessage: 'Too Many Requests' },
  UNAVAILABLE: { statusCode: 503, statusMessage: 'Service Unavailable' },
}

export function isBusinessErrorCode(value: unknown): value is BusinessErrorCode {
  return BUSINESS_ERROR_CODES.some(code => code === value)
}

/** 只在已有外部错误码时用于 HTTP → 本地业务码适配，不给无 code 的旧错误补码。 */
export function businessCodeForStatus(statusCode: number): BusinessErrorCode | undefined {
  return BUSINESS_ERROR_CODES.find(code => BUSINESS_ERROR_HTTP[code]?.statusCode === statusCode)
}

/** Fallback codes cover middleware/router failures as well as domain errors. */
export function apiErrorCode(status: number): BusinessErrorCode {
  if (status === 422) return 'VALIDATION'
  if (status === 502 || status === 504) return 'UNAVAILABLE'
  return businessCodeForStatus(status) ?? (status >= 500 ? 'INTERNAL' : 'REQUEST_FAILED')
}
