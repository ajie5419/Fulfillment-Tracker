import { convertAlert } from '../../../services/alerts/reminders'

/** 黄色预警手动转异常：预警责任人、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  return convertAlert(routeId(event), actorOf(event, user), scopeWorkOrders(await getScope(event)))
})
