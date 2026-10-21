/** 项目日历接口的 zod 片段 */
import { z } from 'zod'
import { dayString } from './flow'

export const calendarQuery = z.object({
  view: z.enum(['week', 'month'], { message: '视图只能是 week / month' }).default('month'),
  /** 这一期里的任意一天；不填 = 今天（北京时间） */
  d: dayString.nullish().transform((v) => v ?? null),
})
