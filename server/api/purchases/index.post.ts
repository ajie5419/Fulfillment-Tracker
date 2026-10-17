import { createLine } from '../../services/purchases/purchases'
import { newLineBody } from '../../schemas/purchases'

/** 新建采购行（关键物料）。能看到该工单的人都可以录入 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newLineBody)
  await assertCanSee(event, input.workOrderNumber)
  const line = await createLine(input, user.qmsUserId)
  return { id: line.id }
})
