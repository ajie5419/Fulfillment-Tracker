import { getNode } from '../../services/kitting/kitting'

/** 单个装配节点（编辑、从 W8 提醒跳转）。能看到该工单的人，或节点负责人本人 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeNode(event, id, user)
  return getNode(id, actorOf(event, user))
})
