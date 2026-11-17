import { convertAlert } from '../../../services/alerts/reminders'

/** 黄色预警手动转异常：预警责任人、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  // Object responsibility also permits assignments outside a manager's own projects.
  return convertAlert(routeId(event), actorOf(event, user))
})
