import { confirmCustomer } from '../../../services/drawings/drawings'
import { confirmBody } from '../../../schemas/drawings'

/** 录客户确认：技术部、管理员（能看到该工单，或是设计负责人本人）。确认日默认今天 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  await assertCanOperateDrawing(event, id)
  const { date, note } = await parseBody(event, confirmBody)
  return confirmCustomer(id, date, user.qmsUserId, note)
})
