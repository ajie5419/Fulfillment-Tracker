import { send, setResponseHeader, setResponseStatus, type H3Error, type H3Event } from 'h3'
import { apiErrorCode, isBusinessErrorCode } from '../shared/errors'
import type { ApiFailure } from '../shared/api-response'
import { finishRequest, recordRequestError } from './observability/request'

/** Unexpected failures must not disclose stack traces or database diagnostics. */
export function apiFailure(error: H3Error): ApiFailure {
  const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
  const sensitive = status >= 500 || error.unhandled || error.fatal
  const details = !sensitive && error.data && typeof error.data === 'object' ? error.data as Record<string, unknown> : {}
  const { code, ...data } = details
  return {
    code: isBusinessErrorCode(code) ? code : apiErrorCode(status),
    data: Object.keys(data).length ? data : null,
    message: sensitive ? '服务暂时不可用，请稍后重试' : error.message || error.statusMessage || '请求失败',
  }
}

/** Runs before Nitro's fallback so middleware and unknown API routes share the contract. */
export default function apiErrorHandler(error: H3Error, event: H3Event) {
  const path = event.path.split('?')[0]
  if (!(path === '/api' || path?.startsWith('/api/')) || event.handled) return
  const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
  setResponseStatus(event, status)
  recordRequestError(event, error, status)
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return send(event, JSON.stringify(apiFailure(error))).finally(() => finishRequest(event))
}
