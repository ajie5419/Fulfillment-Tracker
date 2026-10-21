import { getCalendar } from '../../services/calendar/calendar'
import { calendarQuery } from '../../schemas/calendar'

/** 项目日历：某一周 / 某个月的计划完成、实际完成台数，趋势，完成工单和到期节点。所有登录用户看全部工单（不含金额） */
export default defineFlowHandler(async (event) => {
  const { view, d } = parseQuery(event, calendarQuery)
  return getCalendar(view, d)
})
