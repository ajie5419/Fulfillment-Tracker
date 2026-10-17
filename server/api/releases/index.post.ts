import { createRelease } from '../../services/releases/releases'
import { newReleaseBody } from '../../schemas/releases'

/** 新建发放单：能看到该工单的登录用户都可以发（技术、工艺都用；不审批） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newReleaseBody)
  await assertCanSee(event, input.workOrderNumber)
  return createRelease(input, user.qmsUserId)
})
