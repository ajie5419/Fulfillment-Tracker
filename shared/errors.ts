/** 履约对外的最小业务错误码表；未迁移的错误仍可不带 code。 */
export const BUSINESS_ERROR_CODES = ['NOT_FOUND', 'CONFLICT', 'VALIDATION', 'INTERNAL'] as const
export type BusinessErrorCode = typeof BUSINESS_ERROR_CODES[number]

/** INTERNAL 不覆盖原来的 HTTP 状态（例如 QMS 不可用仍为 503）。 */
export const BUSINESS_ERROR_HTTP: Partial<Record<BusinessErrorCode, { statusCode: number; statusMessage: string }>> = {
  NOT_FOUND: { statusCode: 404, statusMessage: 'Not Found' },
  CONFLICT: { statusCode: 409, statusMessage: 'Conflict' },
  VALIDATION: { statusCode: 400, statusMessage: 'Bad Request' },
}

export function isBusinessErrorCode(value: unknown): value is BusinessErrorCode {
  return BUSINESS_ERROR_CODES.some(code => code === value)
}

/** 只在已有外部错误码时用于 HTTP → 本地业务码适配，不给无 code 的旧错误补码。 */
export function businessCodeForStatus(statusCode: number): BusinessErrorCode | undefined {
  return BUSINESS_ERROR_CODES.find(code => BUSINESS_ERROR_HTTP[code]?.statusCode === statusCode)
}
