import { deletePayment } from '../../services/purchases/payments'

/** 删除付款申请：申请人或管理员，已付的不能删 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePayment(event, id)
  return deletePayment(id, actorOf(event, user))
})
