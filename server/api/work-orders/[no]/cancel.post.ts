import { cancelWorkOrder } from '../../../services/workorder/manage'

/** 取消工单（QMS 里 status = CANCELLED，不删除）：项目部、管理员。可见性校验同修改 */
export default defineFlowHandler(async (event) => {
  const no = routeId(event, 'no')
  await assertCanSee(event, no)
  return cancelWorkOrder(await getRoleContext(event), no, qmsWorkOrderApi(event))
})
