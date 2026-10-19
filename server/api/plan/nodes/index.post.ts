import { createNode } from '../../../services/plan/plan'
import { newNodeBody } from '../../../schemas/plan'

/** 加节点（发布后要写原因）：该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const { workOrderNumber, ...input } = await parseBody(event, newNodeBody)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'plan', { workOrderNumber })
  return createNode(workOrderNumber, input, user.qmsUserId)
})
