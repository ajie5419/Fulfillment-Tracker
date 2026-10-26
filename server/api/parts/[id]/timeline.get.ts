import { partTimeline } from '../../../services/flow/timeline'
import { FlowError } from '../../../services/flow/errors'

/** 工件时间线（只读）：建档、设计任务、关键物料、工序流转、异常、留言，新的在上 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  const t = await partTimeline(id)
  if (!t) throw new FlowError('工件不存在或已删除')
  return t
})
