import { updateLine } from '../../services/purchases/purchases'
import { patchLineBody } from '../../schemas/purchases'

/** 修改采购行（含延误原因、取消 / 重新启用、改到货日）。采购部、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  await assertCanOperatePurchase(event, id)
  const line = await updateLine(id, await parseBody(event, patchLineBody))
  return { id: line.id }
})
