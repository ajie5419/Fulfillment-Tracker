import { getIssue } from '../../services/issues/issues'

/** 异常详情：照片、处理日志、当前用户可做的操作 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return getIssue(id, actorOf(event, user))
})
