import { removeOffDay } from '../../../services/alerts/settings'
import { day } from '../../../schemas/flow'

/** 删一个停工日（路径参数 YYYY-MM-DD）。仅管理员 */
export default defineAdminHandler(async (event) => {
  const r = day.safeParse(routeId(event, 'date'))
  if (!r.success) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '日期格式应为 YYYY-MM-DD' })
  return removeOffDay(r.data)
})
