import { z } from 'zod'
import { ALERT_RULES } from '../../../../shared/alert-rules'
import { saveThreshold } from '../../../services/alerts/settings'

const rule = z.enum(ALERT_RULES, { message: '规则只能是 W1–W11' })
const body = z
  .object({
    remindHours: z.number().int().min(1, '提醒阈值至少 1 小时').max(24 * 30).nullable(),
    yellowDays: z.number().int().min(1, '黄色阈值至少 1 天').max(365),
    redDays: z.number().int().min(1, '红色阈值至少 1 天').max(365),
  })
  .strict()

/** 修改一条规则的阈值。仅管理员 */
export default defineAdminHandler(async (event) => {
  const r = rule.safeParse(routeId(event, 'rule'))
  if (!r.success) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '规则只能是 W1–W11' })
  return saveThreshold(r.data, await parseBody(event, body))
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestBody = z.input<typeof body>
