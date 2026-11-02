import { computed, type Ref } from 'vue'

/** 只投影 Nuxt 请求状态；请求、重试与并发仍由原来的 useFetch/useAsyncData 管理。 */
export function useRequestState(request: { pending: Ref<boolean>; error: Ref<unknown> }, empty: () => boolean) {
  const state = computed(() => request.pending.value ? 'loading' : request.error.value ? 'error' : empty() ? 'empty' : 'success')
  function displayStat(value: number | null | undefined): number | string {
    return request.pending.value || request.error.value || value == null ? '—' : value
  }
  return { state, displayStat }
}
