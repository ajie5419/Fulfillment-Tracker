import { updateWorkOrderBody } from '../../../schemas/work-order'
import { updateWorkOrder } from '../../../services/workorder/manage'

/**
 * 修改工单（写入 QMS，带本地副本的 version）：项目部、管理员。工单号不能改。
 * 先按地址里的工单号做可见性校验（不先查对象，工单不存在也不跳过），再由服务层报"工单不存在"。
 */
export default defineFlowHandler(async (event) => {
  const no = routeId(event, 'no')
  await assertCanSee(event, no)
  const input = await parseBody(event, updateWorkOrderBody)
  const result = await updateWorkOrder(await getRoleContext(event), no, input, qmsWorkOrderApi(event))
  if (result.recovery) setResponseStatus(event, 202)
  return result
})
