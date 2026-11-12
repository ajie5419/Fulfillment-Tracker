import { beginRequest, finishRequest, recordRequestError } from '../observability/request'
import { logEvent } from '../observability/logger'
import { createServer } from 'node:http'
import { installFatalHandlers } from '../observability/fatal'
import { enableProcessMetrics, heartbeat, metrics, taskLastStart, taskLastFinish } from '../observability/metrics'

export default defineNitroPlugin(app => {
  if (process.env.NODE_ENV === 'production') {
    const remove = installFatalHandlers()
    app.hooks.hook('close', remove)
  }
  const pulse = () => {
    heartbeat.set(Date.now() / 1000)
    logEvent('info', 'observability.heartbeat')
  }
  pulse()
  const timer = setInterval(pulse, 30_000)
  timer.unref()
  app.hooks.hook('close', () => { clearInterval(timer) })
  if (process.env.FT_METRICS_ENABLED === '1') {
    enableProcessMetrics()
    for (const task of ['sync-qms', 'scan-rules']) {
      taskLastStart.set({ task }, Date.now() / 1000)
      taskLastFinish.set({ task }, Date.now() / 1000)
    }
    const server = createServer(async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return }
      try { res.setHeader('content-type', metrics.contentType); res.end(await metrics.metrics()) }
      catch (error) { logEvent('error', 'metrics.failed', {}, error); res.writeHead(503).end() }
    })
    server.on('error', error => { logEvent('fatal', 'metrics.listener.failed', {}, error); process.exitCode = 1; process.exit(1) })
    // Separate internal port; never publish it through the application reverse proxy.
    server.listen(9464, process.env.FT_METRICS_HOST ?? '127.0.0.1')
    app.hooks.hook('close', () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  }
  app.hooks.hook('request', event => { beginRequest(event) })
  app.hooks.hook('afterResponse', event => { finishRequest(event) })
  app.hooks.hook('error', (error, context) => {
    if (context.event) recordRequestError(context.event, error, 'statusCode' in error ? Number(error.statusCode) || 500 : 500)
    else logEvent('error', 'runtime.failed', {}, error)
  })
})
