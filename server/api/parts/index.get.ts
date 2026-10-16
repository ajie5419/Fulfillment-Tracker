import { z } from 'zod'
import { listParts } from '../../services/flow/steps'

const query = z.object({ workOrderNumber: z.string().min(1).max(64) })

/** 工单下的工件及工序链 */
export default defineFlowHandler(async (event, user) => {
  const { workOrderNumber } = parseQuery(event, query)
  assertCanSee(user, workOrderNumber)
  return listParts(workOrderNumber)
})
