import { getTask } from '../../services/drawings/drawings'

/** 单个设计任务（编辑、从提醒跳转）。能看到该工单的人，或设计负责人本人 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  return getTask(id, actorOf(event, user))
})
