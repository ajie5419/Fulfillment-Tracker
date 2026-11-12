import type { AsyncData, NuxtError, UseFetchOptions } from 'nuxt/app'
import type { Ref } from 'vue'
import type { ApiData } from '../types/api-payload'
import { createApiFetch, type RawApiFetch } from '../utils/api-fetch'

/** Keep authentication scoped to this SSR request, including calls outside useFetch. */
export function useApiRequestFetch() {
  return createApiFetch(useRequestFetch() as RawApiFetch)
}

type ApiFetchOptions<D> = Omit<UseFetchOptions<NoInfer<D>>, 'default' | 'transform' | 'pick' | 'method' | '$fetch'>

export function useApiFetch<T = unknown, R extends string = string, D = unknown extends T ? ApiData<R> : T, Default = D>(
  request: R | Ref<R> | (() => R), options: ApiFetchOptions<D> & { default: () => Default | Ref<Default> },
): AsyncData<D | Default, NuxtError | undefined>
export function useApiFetch<T = unknown, R extends string = string, D = unknown extends T ? ApiData<R> : T>(
  request: R | Ref<R> | (() => R), options?: ApiFetchOptions<D>,
): AsyncData<D | undefined, NuxtError | undefined>
export function useApiFetch(request: string | Ref<string> | (() => string), options?: object): unknown {
  // Decode inside Nuxt's request lifecycle, preserving defaults, hydration and cancellation.
  return useFetch(request, { ...options, $fetch: useApiRequestFetch() as typeof $fetch })
}
