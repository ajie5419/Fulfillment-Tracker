import { undoCustomer } from '../../../services/drawings/drawings'

/** 撤销客户确认（录错了）：能看到该工单的人或设计负责人本人 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  return undoCustomer(id)
})
