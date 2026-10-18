import { rejectReceipt } from '../../../services/releases/releases'
import { rejectBody } from '../../../schemas/releases'

/** 拒收并写原因（如"版本不对"）：只能拒收发给自己的；通知发放人 */
export default defineFlowHandler(async (event, user) => {
  const { reason } = await parseBody(event, rejectBody)
  return rejectReceipt(routeId(event), user.qmsUserId, reason)
})
