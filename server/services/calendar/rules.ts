/**
 * 项目日历的"实际完成日"：只认落了库、不会随日子变的日期。
 *   手动标记完成 → 手动填的完成日；
 *   挂靠任务全部完成自动完成 → 各任务记录的完成日里最晚的那个（设计完成 / 客户确认日、到货日、工序完成时刻、齐套日）。
 *     有任务缺完成日时（总计划里按今天算，会每天变）返回 null：算"已完成"，但不计入哪一期的实际完成，页面提示手动标记。
 */
import type { NodeEstimate, TaskFacts } from '../plan/constants'

export function stableDoneDay(est: Pick<NodeEstimate, 'done' | 'doneBy' | 'actualDay'>, tasks: readonly Pick<TaskFacts, 'excluded' | 'doneDay'>[]): string | null {
  if (!est.done) return null
  if (est.doneBy === 'MANUAL') return est.actualDay
  const counted = tasks.filter((t) => !t.excluded)
  if (!counted.length || counted.some((t) => !t.doneDay)) return null
  return counted.map((t) => t.doneDay!).reduce((a, b) => (a >= b ? a : b))
}
