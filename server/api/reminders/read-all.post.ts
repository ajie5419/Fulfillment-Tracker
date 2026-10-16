import { markAllRead } from '../../services/alerts/reminders'

/** 全部已读 */
export default defineFlowHandler(async (_event, user) => markAllRead(user.qmsUserId))
