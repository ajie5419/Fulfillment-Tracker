import { getPlan } from '../../services/plan/plan'
import { woQuery } from '../../schemas/plan'

/** 总计划页：某个工单的总计划（节点、预计、挂靠任务、调整记录）。能看到该工单的人都能看 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber } = parseQuery(event, woQuery)
  await assertCanSee(event, workOrderNumber)
  return getPlan(workOrderNumber, await getRoleContext(event))
})
