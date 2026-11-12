const MONITORING_TARGETS = [
  'http://prometheus:9090/-/ready',
  'http://alertmanager:9093/-/ready',
  'http://alloy:12345/-/ready',
  'http://loki:3100/ready',
] as const

/** Fixed internal targets prevent this public readiness endpoint from becoming an SSRF proxy. */
export async function monitoringReady(fetcher: typeof fetch = fetch) {
  const results = await Promise.allSettled(MONITORING_TARGETS.map(url => fetcher(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }).then(async response => {
    await response.body?.cancel()
    return response.ok
  })))
  return results.every(result => result.status === 'fulfilled' && result.value)
}
