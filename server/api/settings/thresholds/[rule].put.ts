import { z } from 'zod'
import { saveThreshold } from '../../../services/alerts/settings'

const rule = z.enum(['W1', 'W2', 'W3', 'W4', 'W5', 'W6'], { message: '规则只能是 W1–W6' })
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
  if (!r.success) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '规则只能是 W1–W6' })
  return saveThreshold(r.data, await parseBody(event, body))
})
