import { ignoreUnmatched } from '../../../services/flow/match'

/** 忽略待确认匹配：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeInspection(event, id)
  await assertCanOperateInspection(event, id)
  return ignoreUnmatched(id, user.qmsUserId)
})
