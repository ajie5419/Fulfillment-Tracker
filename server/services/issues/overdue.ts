/** 异常列表、看板、总览共用的实时超期口径；不改扫描持久化的 W4 级别。 */
import { DAY_MS, judgeW4, type RuleThreshold, type W4Input } from '../alerts/rules'

/**
 * 待受理满 W4 黄阈值，或待受理 / 处理中已过要求解决日，即为超期。
 * 沿用 W4 的北京时间日界和停工日扣除；待确认、已关闭始终不算。
 * overdueDays 只表示超过要求解决日的天数：单纯待受理超时仍为 0。
 * color 是看板的实时异常输入；alertLevel 仍由原扫描任务独立维护。
 */
export function judgeIssueOverdue(input: W4Input, threshold: RuleThreshold) {
  const judged = judgeW4(input, threshold)
  const overdue = judged.watched && (judged.overdueDays > 0 || (input.status === 'OPEN' && judged.openMs >= threshold.yellowDays * DAY_MS))
  const color = !overdue ? null : judged.overdueDays >= threshold.redDays ? 'RED' : 'YELLOW'
  return { overdue, overdueDays: judged.overdueDays, color }
}
