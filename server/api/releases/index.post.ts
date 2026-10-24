import { createRelease } from '../../services/releases/releases'
import { newReleaseBody } from '../../schemas/releases'

/** 新建发放单：技术部、管理员；工艺部只能发工艺文件（能看到该工单；不审批） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newReleaseBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber: input.workOrderNumber, releaseType: input.type })
  return createRelease(input, user.qmsUserId)
})
