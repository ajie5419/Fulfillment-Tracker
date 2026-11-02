import { retryWorkOrderSave } from '../../../../services/workorder/recovery'

/** 仅管理员，沿用设置页的鉴权与错误映射；可重复调用。 */
export default defineAdminHandler(async (event) => {
  const result = await retryWorkOrderSave(routeId(event), qmsWorkOrderApi(event))
  if (result.recovery) setResponseStatus(event, 202)
  return result
})
