import type { NitroFetchOptions } from 'nitropack/types'
import type { ClientApi } from '../types/client-api'

type Matches<P extends string, R extends string> = R extends `${infer Head}/${infer Tail}`
  ? P extends `${infer First}/${infer Rest}` ? (Head extends `:${string}` ? Matches<Rest, Tail> : First extends Head ? Matches<Rest, Tail> : false) : false
  : R extends `:${string}` ? P extends `${string}/${string}` ? false : true : P extends R ? true : false
type Path<P extends string> = P extends `${infer Base}?${string}` ? Base : P
type MatchingRoute<P extends string, R = keyof ClientApi> = R extends string ? Matches<P, R> extends true ? R : never : never
type Route<P extends string> = P extends unknown ? Path<P> extends keyof ClientApi ? Path<P> : MatchingRoute<Path<P>> : never
type RouteMethod<R> = R extends keyof ClientApi ? keyof ClientApi[R] : never
type Method<P extends string> = Extract<RouteMethod<Route<P>>, 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'>
type RouteContract<R, M extends PropertyKey> = R extends keyof ClientApi ? M extends keyof ClientApi[R] ? ClientApi[R][M] : never : never
type Contract<P extends string, M extends PropertyKey> = RouteContract<Route<P>, M>
type Field<C, K extends PropertyKey> = C extends Record<K, infer V> ? V : never
type InputField<K extends string, T> = [T] extends [never] ? { [P in K]?: never }
  : {} extends T ? { [P in K]?: T } : { [P in K]: T }
export type ClientOptions<P extends string, M extends PropertyKey> = Omit<NitroFetchOptions<string>, 'method' | 'body' | 'query' | 'params'>
  & InputField<'body', [Field<Contract<P, M>, 'body'>] extends [never] ? Record<string, never> : Field<Contract<P, M>, 'body'>> & InputField<'query', Field<Contract<P, M>, 'query'>>
type Response<P extends string, M extends PropertyKey> = Field<Contract<P, M>, 'response'>
export type ClientMethod<P extends string> = Method<P>
type RoutePath<R extends string> = R extends `${infer Head}/${infer Tail}` ? `${Head extends `:${string}` ? string : Head}/${RoutePath<Tail>}` : R extends `:${string}` ? string : R
export type ClientPath<M extends string, R = keyof ClientApi> = R extends keyof ClientApi ? M extends keyof ClientApi[R] ? RoutePath<R> : never : never
export type ClientResponse<P extends string, M extends PropertyKey> = Response<P, M>
export type ClientBodyArgs<P extends string, M extends PropertyKey> = [Field<Contract<P, M>, 'body'>] extends [never]
  ? [body?: Record<string, never>] : {} extends Field<Contract<P, M>, 'body'> ? [body?: Field<Contract<P, M>, 'body'>] : [body: Field<Contract<P, M>, 'body'>]
export type ClientFetch = ReturnType<typeof useRequestFetch>
type GetArgs<P extends string> = 'GET' extends Method<P>
  ? {} extends ClientOptions<P, 'GET'> ? [options?: ClientOptions<P, 'GET'>, fetcher?: ClientFetch] : [options: ClientOptions<P, 'GET'>, fetcher?: ClientFetch]
  : [options: never]

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }

/** 同时接受 ofetch、Nuxt AsyncData 和已经归一的错误；保持旧版文案回退顺序。 */
export function clientErrorMessage(error: unknown): string {
  const source = record(error), data = record(source?.data)
  return text(data?.message) || text(data?.statusMessage) || text(source?.message) || '操作失败'
}

/** H3 把业务字段放在响应 data 中，ofetch 再把整个响应放到 error.data 中。 */
export function clientErrorCode(error: unknown): string | undefined {
  const source = record(error), data = record(source?.data)
  return text(source?.code) || text(data?.code) || text(record(data?.data)?.code)
}

export class ClientRequestError extends Error {
  readonly statusCode: number | undefined
  readonly statusMessage: string | undefined
  readonly code: string | undefined
  readonly data: Record<string, unknown>
  constructor(error: unknown) {
    super(clientErrorMessage(error), { cause: error })
    this.name = 'ClientRequestError'
    const source = record(error), data = record(source?.data)
    const status = source?.statusCode ?? source?.status ?? data?.statusCode
    this.statusCode = typeof status === 'number' ? status : undefined
    this.statusMessage = text(data?.statusMessage) || text(source?.statusMessage)
    this.code = clientErrorCode(error)
    this.data = { ...data, message: this.message, statusMessage: this.statusMessage, statusCode: this.statusCode, ...(this.code ? { code: this.code } : {}) }
  }
}

/** 无缓存、无重试策略：原样传递 signal/headers；SSR 调用者传入 useRequestFetch()。 */
export function clientRequest<const P extends string, M extends Method<P>>(url: P, options: ClientOptions<P, M> & { method: M }, fetcher?: ClientFetch): Promise<Response<P, M>>
export function clientRequest<const P extends string>(url: P, ...args: GetArgs<P>): Promise<Response<P, 'GET'>>
export async function clientRequest(url: string, options?: unknown, fetcher: ClientFetch = $fetch): Promise<unknown> {
  return sendClientRequest(url, options, fetcher)
}

/** 供领域函数重载的实现使用：返回 unknown，不能由调用点指定响应类型。 */
export async function sendClientRequest(url: string, options?: unknown, fetcher: ClientFetch = $fetch): Promise<unknown> {
  try {
    return await fetcher<unknown, string>(url, options as NitroFetchOptions<string> | undefined)
  } catch (error) {
    if (record(error)?.name === 'AbortError') throw error
    throw error instanceof ClientRequestError ? error : new ClientRequestError(error)
  }
}
