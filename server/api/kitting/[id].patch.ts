import { updateNode } from '../../services/kitting/kitting'
import { patchNodeBody } from '../../schemas/kitting'

/** 修改装配节点（名称、需求日、负责人、备注、排序、清单）：能看到该工单，且是生产经理、该工单项目经理或管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeNode(event, id)
  return updateNode(id, await parseBody(event, patchNodeBody), actorOf(event, user))
})
