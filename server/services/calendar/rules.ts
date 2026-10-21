/**
 * 项目日历的"实际完成日"：只认落了库、不会随日子变的日期。
 *   手动标记完成 → 手动填的完成日；
 *   挂靠任务全部完成自动完成 → 各任务记录的完成日里最晚的那个，但前提是每个计入的任务都有记录的完成日。
 *     装配节点（齐套）的完成日不落库，总计划里按"需求日和今天较早的那个"现算，提前齐套的会每天往后挪；
 *     没记完成日的任务总计划里按今天算，也会每天变。这两种情况返回 null：算"已完成"，但不计入哪一期的实际完成，
 *     页面提示去总计划里手动标记发运完成。
 */
import type { NodeEstimate, TaskFacts } from '../plan/constants'

export function stableDoneDay(est: Pick<NodeEstimate, 'done' | 'doneBy' | 'actualDay'>, tasks: readonly Pick<TaskFacts, 'kind' | 'excluded' | 'doneDay'>[]): string | null {
  if (!est.done) return null
  if (est.doneBy === 'MANUAL') return est.actualDay
  const counted = tasks.filter((t) => !t.excluded)
  if (!counted.length || counted.some((t) => t.kind === 'assembly' || !t.doneDay)) return null
  return counted.map((t) => t.doneDay!).reduce((a, b) => (a >= b ? a : b))
}
