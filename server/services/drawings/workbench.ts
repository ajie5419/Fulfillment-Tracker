import { prisma } from '../../utils/prisma'
import { dateFieldDay, todayDay } from '../../../shared/dates'
import { workBucket } from '../../../shared/workbench'
import { DO_DESIGN_TASK } from '../../../shared/drawing'

/** Project the current design assignment rather than duplicating its lifecycle in
 * the todo table. Reassignment, completion and cancellation take effect immediately.
 */
export async function myDesignWork(userId: string, now: Date) {
  const tasks = await prisma.drawingTask.findMany({ where: { ownerId: userId, status: 'PENDING' }, orderBy: [{ planDate: 'asc' }, { id: 'asc' }] })
  return tasks.map((task) => {
    const dueDay = dateFieldDay(task.planDate)
    return {
      id: `drawing:${task.id}`, ownerId: userId, action: DO_DESIGN_TASK, refType: 'drawing', refId: task.id,
      status: 'OPEN' as const, dueAt: task.planDate, doneAt: null, createdAt: task.createdAt,
      actionText: '完成设计任务', title: `完成设计任务：${task.workOrderNumber} · ${task.componentName}`,
      suggestion: '查看设计任务，完成设计后登记完成；调整责任人请在设计任务中修改。',
      workOrderNumber: task.workOrderNumber, dueDay, bucket: workBucket({ kind: 'todo', dueDay }, todayDay(now)),
      link: `/drawings?mine=1&id=${encodeURIComponent(task.id)}`,
      step: null, release: null, plan: null, planTask: null,
    }
  })
}
