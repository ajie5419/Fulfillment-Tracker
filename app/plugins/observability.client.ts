import { CLIENT_FAILURE_EVENT, createErrorReporter, sendClientReport } from '../utils/error-reporter'

export default defineNuxtPlugin(app => {
  const router = useRouter()
  const report = createErrorReporter(sendClientReport, () => {
    const template = router.currentRoute.value.matched.at(-1)?.path ?? 'unmatched'
    return template.replace(/[^a-zA-Z0-9_/:.[\]-]/g, '').slice(0, 160)
  })
  const error = (event: Event) => {
    if (event instanceof ErrorEvent) report('javascript', event.error ?? event.message)
    else report('resource', new Error(`resource:${(event.target as Element | null)?.tagName ?? 'unknown'}`))
  }
  const rejection = (event: PromiseRejectionEvent) => report('promise', event.reason)
  const request = (event: Event) => {
    const detail = (event as CustomEvent<{ error: unknown; requestId?: string; statusCode?: number }>).detail
    report('request', detail.error, { requestId: detail.requestId, statusCode: detail.statusCode })
  }
  const stops = [app.hook('vue:error', error => report('vue', error)), app.hook('app:error', error => report('app', error))]
  window.addEventListener('error', error, true)
  window.addEventListener('unhandledrejection', rejection)
  window.addEventListener(CLIENT_FAILURE_EVENT, request)
  if (import.meta.hot) import.meta.hot.dispose(() => {
    stops.forEach(stop => stop())
    window.removeEventListener('error', error, true)
    window.removeEventListener('unhandledrejection', rejection)
    window.removeEventListener(CLIENT_FAILURE_EVENT, request)
  })
})
