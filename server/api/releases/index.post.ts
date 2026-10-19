import { createRelease } from '../../services/releases/releases'
import { newReleaseBody } from '../../schemas/releases'

/** 新建发放单：技术部、管理员（能看到该工单；不审批） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newReleaseBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber: input.workOrderNumber })
  return createRelease(input, user.qmsUserId)
})
