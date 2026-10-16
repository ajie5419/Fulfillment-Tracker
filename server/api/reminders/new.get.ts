import { z } from 'zod'
import { newReminders } from '../../services/alerts/reminders'

const query = z.object({ since: z.string().datetime({ message: '时间格式不正确' }).optional() })

/** 电脑端右上角弹出：since 之后新的未读黄色、红色提醒。不带 since 只返回服务器时间作为起点 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { since } = parseQuery(event, query)
  return newReminders(user.qmsUserId, since ? new Date(since) : null)
})
