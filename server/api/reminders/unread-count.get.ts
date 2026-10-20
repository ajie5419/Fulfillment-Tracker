import { unreadCount } from '../../services/alerts/reminders'

/** 未读提醒数（电脑端菜单"工作台"角标，60 秒随布局轮询刷新）：只数本人的提醒，与 GET /api/reminders 的 unread 同一口径 */
export default defineEventHandler(async (event) => unreadCount(requireUser(event).qmsUserId))
