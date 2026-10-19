import { createLine } from '../../services/purchases/purchases'
import { newLineBody } from '../../schemas/purchases'

/** 新建采购行（关键物料）：采购部、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newLineBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'purchase', { workOrderNumber: input.workOrderNumber })
  const line = await createLine(input, user.qmsUserId)
  return { id: line.id }
})
