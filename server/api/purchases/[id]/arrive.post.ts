import { confirmArrival } from '../../../services/purchases/purchases'
import { arriveBody } from '../../../schemas/purchases'

/** 手工确认到货（采购、仓库、使用部门都可以；手机签收页或电脑）。晚到的可同时填延误原因 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  return confirmArrival(id, await parseBody(event, arriveBody), user.qmsUserId)
})
