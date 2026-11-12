import { logEvent } from './logger'

/** Observe the transport without logging URLs, payloads or credentials, and preserve existing timeouts and retry semantics. */
export function observedFetch(module: string, fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const start = performance.now()
    try {
      const response = await fetcher(input, init)
      if (!response.ok) logEvent('error', 'dependency.http.failed', { module, statusCode: response.status, durationMs: Math.round(performance.now() - start) })
      return response
    } catch (error) {
      logEvent('error', 'dependency.transport.failed', { module, durationMs: Math.round(performance.now() - start) }, error)
      throw error
    }
  }
}
