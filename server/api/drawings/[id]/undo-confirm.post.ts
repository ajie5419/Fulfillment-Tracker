import { undoCustomer } from '../../../services/drawings/drawings'

/** 撤销客户确认（录错了）：技术部、管理员（能看到该工单，或是设计负责人本人） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  await assertCanOperateDrawing(event, id)
  return undoCustomer(id)
})
