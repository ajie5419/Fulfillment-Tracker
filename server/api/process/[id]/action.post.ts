import { changeStatus } from '../../../services/process/process'
import { actionBody } from '../../../schemas/process'

/** 改料单 / 工艺状态（开始编制 / 下发 / 修改 / 撤回）：工艺部、管理员，且能看到该工单 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeProcess(event, id)
  await assertCanOperate(event, 'processDoc')
  return changeStatus(id, await parseBody(event, actionBody), user.qmsUserId)
})
