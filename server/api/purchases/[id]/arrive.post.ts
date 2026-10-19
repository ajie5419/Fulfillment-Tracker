import { confirmArrival } from '../../../services/purchases/purchases'
import { arriveBody } from '../../../schemas/purchases'

/** 手工确认到货（手机签收页或电脑）：采购部、该工单项目经理、管理员。晚到的可同时填延误原因。QMS 进货检验自动到货不经过这里 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  await assertCanOperatePurchase(event, id)
  return confirmArrival(id, await parseBody(event, arriveBody), user.qmsUserId)
})
