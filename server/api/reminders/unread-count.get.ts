import { unreadCount } from '../../services/alerts/reminders'
import { CONFIRM_PLAN_NODE, PLAN_REF } from '../../services/plan/constants'

/**
 * 电脑端菜单角标（60 秒随布局轮询刷新）：
 *   unread —— "工作台"：本人的未读提醒，与 GET /api/reminders 的 unread 同一口径；
 *   planPending —— "部门计划"：本人手里待接收的计划节点（接收待办）。
 */
export default defineEventHandler(async (event) => {
  const userId = requireUser(event).qmsUserId
  const [unread, planPending] = await Promise.all([
    unreadCount(userId),
    prisma.todo.count({ where: { ownerId: userId, refType: PLAN_REF, action: CONFIRM_PLAN_NODE, status: 'OPEN' } }),
  ])
  return { ...unread, planPending }
})
