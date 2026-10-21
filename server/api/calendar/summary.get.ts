import { getCalendarSummary } from '../../services/calendar/calendar'

/** 工作台"项目日历"卡片：本周、下周、本月的计划完成、实际完成、逾期未完成台数 */
export default defineFlowHandler(async () => getCalendarSummary())
