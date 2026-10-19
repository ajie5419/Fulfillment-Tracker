import { getWorkOrderDetail } from '../../../services/workorder/detail'

/**
 * 工单详情（以工单为中心的页面）：总计划时间线 + 挂在节点上的部门记录、总装齐套、活动预警、未关闭异常、谁在拖、未挂节点数。
 * 能看到该工单的人才能看（与工单下其他接口一致：看不到 403，工单不存在 404）。不含付款金额。
 */
export default defineFlowHandler(async (event, user) => {
  const no = routeId(event, 'no')
  await assertCanSee(event, no)
  const detail = await getWorkOrderDetail(no, await getRoleContext(event), actorOf(event, user), scopeWorkOrders(await getScope(event)))
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Not Found', message: '工单不存在' })
  return detail
})
