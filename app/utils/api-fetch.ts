import type { NitroFetchOptions } from 'nitropack/types'
import { unwrapApiResponse } from '#shared/api-response'
import type { ApiData } from '../types/api-payload'

export type ApiFetch = <T = unknown, R extends string = string, O extends NitroFetchOptions<string> = NitroFetchOptions<string>>(
  request: R, options?: O,
) => Promise<unknown extends T ? ApiData<R, O extends { method: infer M extends string } ? M : 'get'> : T>

export type RawApiFetch = (request: string, options?: NitroFetchOptions<string>) => Promise<unknown>

/** Request-scoped fetch preserves SSR cookies; never cache one user's fetch globally. */
export function createApiFetch(fetcher: RawApiFetch): ApiFetch {
  return (async (request: string, options?: NitroFetchOptions<string>) => {
    const result = await fetcher(request, options)
    return unwrapApiResponse(result)
  }) as ApiFetch
}

export const apiFetch: ApiFetch = (request, options) => createApiFetch($fetch as RawApiFetch)(request, options)
