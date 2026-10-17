import { updateLine } from '../../services/purchases/purchases'
import { patchLineBody } from '../../schemas/purchases'

/** 修改采购行（含延误原因、取消 / 重新启用、改到货日）。能看到该工单的人都可以改 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  const line = await updateLine(id, await parseBody(event, patchLineBody))
  return { id: line.id }
})
