import { acceptClientReport } from '../../observability/client-report'

export default defineApiHandler(async event => {
  const result = await acceptClientReport(event)
  setResponseStatus(event, 202)
  return result
})
