import { monitoringReady } from '../../observability/health'

export default defineApiHandler(async event => {
  if (process.env.FT_METRICS_ENABLED !== '1' || !await monitoringReady()) {
    setResponseStatus(event, 503)
    return { ok: false }
  }
  return { ok: true }
})
