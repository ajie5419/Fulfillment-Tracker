import { createWorkOrderBody } from '../../schemas/work-order'
import { createWorkOrder } from '../../services/workorder/manage'

/** 新建工单（写入 QMS 工单库，成功后写本地副本 + 项目经理 / 产品线 / 是否试点）：项目部、管理员 */
export default defineFlowHandler(async (event) => {
  const input = await parseBody(event, createWorkOrderBody)
  const result = await createWorkOrder(await getRoleContext(event), input, qmsWorkOrderApi(event))
  if (result.recovery) setResponseStatus(event, 202)
  return result
})
