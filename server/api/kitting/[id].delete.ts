import { deleteNode } from '../../services/kitting/kitting'

/** 删除装配节点（清单一并删除，W8 预警消除）：能看到该工单，且是生产经理、该工单项目经理或管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeNode(event, id)
  return deleteNode(id, actorOf(event, user))
})
