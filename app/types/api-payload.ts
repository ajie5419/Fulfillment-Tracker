import type { InternalApi } from 'nitropack/types'
import type { ApiPayload } from '../../shared/api-response'

type Matches<P extends string, R extends string> = R extends `${infer Head}/${infer Tail}`
  ? P extends `${infer First}/${infer Rest}` ? (Head extends `:${string}` ? Matches<Rest, Tail> : First extends Head ? Matches<Rest, Tail> : false) : false
  : R extends `:${string}` ? P extends `${string}/${string}` ? false : true : P extends R ? true : false
type Path<P extends string> = P extends `${infer Base}?${string}` ? Base : P
type Matched<P extends string> = { [R in keyof InternalApi]: Matches<Path<P>, R> extends true ? R : never }[keyof InternalApi]
type Route<P extends string> = Path<P> extends keyof InternalApi ? Path<P> : Matched<P>
type Response<R, M extends string> = R extends keyof InternalApi ? Lowercase<M> extends keyof InternalApi[R] ? InternalApi[R][Lowercase<M>] : never : never

/** Read Nitro's generated contracts without recursively scoring every route during inference. */
export type ApiData<P extends string, M extends string = 'get'> = ApiPayload<Response<Route<P>, M>>
