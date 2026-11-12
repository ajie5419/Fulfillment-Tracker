import type { BusinessErrorCode } from './errors'

export interface ApiSuccess<T> {
  code: 0
  data: T
  message: 'ok'
}

export interface ApiFailure {
  code: BusinessErrorCode
  data: Record<string, unknown> | null
  message: string
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure
export type ApiPayload<T> = T extends ApiSuccess<infer D> ? D : T

/** Undefined results must survive JSON serialization as an explicit null. */
export function apiSuccess<T>(data: T): ApiSuccess<T extends void ? null : T> {
  return { code: 0, data: (data === undefined ? null : data) as T extends void ? null : T, message: 'ok' }
}

/** A broken contract must fail visibly instead of appearing as an empty page. */
export function unwrapApiResponse(value: unknown): unknown {
  if (value && typeof value === 'object' && 'code' in value && value.code === 0
    && 'data' in value && 'message' in value && value.message === 'ok') return value.data
  throw new Error('接口响应格式不正确，请刷新后重试')
}
