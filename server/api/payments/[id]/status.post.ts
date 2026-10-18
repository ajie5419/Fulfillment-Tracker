import { setPaymentStatus } from '../../../services/purchases/payments'
import { paymentStatusBody } from '../../../schemas/purchases'

/** 改财务状态（待付 / 已付 / 暂缓）：仅财务或管理员（服务层校验，其他人 403） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePayment(event, id)
  const { status, note } = await parseBody(event, paymentStatusBody)
  return setPaymentStatus(id, status, note, actorOf(event, user))
})
