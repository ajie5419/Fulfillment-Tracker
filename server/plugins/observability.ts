import { beginRequest, finishRequest, recordRequestError } from '../observability/request'
import { logEvent } from '../observability/logger'

export default defineNitroPlugin(app => {
  app.hooks.hook('request', event => { beginRequest(event) })
  app.hooks.hook('afterResponse', event => { finishRequest(event) })
  app.hooks.hook('error', (error, context) => {
    if (context.event) recordRequestError(context.event, error, 'statusCode' in error ? Number(error.statusCode) || 500 : 500)
    else logEvent('error', 'runtime.failed', {}, error)
  })
})
