import { cancelWorkOrderBody } from '../../../schemas/work-order'
import { cancelWorkOrder } from '../../../services/workorder/manage'

/** 取消工单（QMS 里 status = CANCELLED，不删除）：项目部、管理员。带详情页上看到的 version。可见性校验同修改 */
export default defineFlowHandler(async (event) => {
  const no = routeId(event, 'no')
  await assertCanSee(event, no)
  const input = await parseBody(event, cancelWorkOrderBody)
  return cancelWorkOrder(await getRoleContext(event), no, input, qmsWorkOrderApi(event))
})
