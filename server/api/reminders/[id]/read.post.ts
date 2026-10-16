import { markRead } from '../../../services/alerts/reminders'

/** 标记一条提醒已读（只能标自己的） */
export default defineFlowHandler(async (event, user) => markRead(user.qmsUserId, routeId(event)))
