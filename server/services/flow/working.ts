/**
 * 加工中（手机端"加工中"页）：已开工还没完工的自制 / 厂内外协工序，车间在手机上点"完工"。
 * 借鉴 ERPNext 作业卡"开工 → 完工"的按钮流（10-26）：之前手机端只能开工，完工只有电脑端工件页有。
 */
import { prisma } from '../../utils/prisma'
import { overdueDays } from './dates'
import { RETURN_TYPES } from './flow'
import { loadNames } from './names'

/** ownerId：只看这个人负责的；visibleWorkOrders：可见工单（undefined = 全部，见 server/utils/auth.ts 的 getScope） */
export async function listWorking(filter: { ownerId?: string; visibleWorkOrders?: string[] }) {
  const steps = await prisma.routeStep.findMany({
    where: {
      status: 'IN_PROGRESS',
      mode: { in: ['SELF', 'IN_PLANT_OUTSOURCE'] },
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
      ...(filter.visibleWorkOrders ? { part: { workOrderNumber: { in: filter.visibleWorkOrders } } } : {}),
    },
    include: { part: true },
    // 要求完成日早的在前，没有要求完成日的排最后
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { startedAt: 'asc' }],
  })
  const [names, sums] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId), user: steps.map((s) => s.ownerId) }),
    // 部分完工（报工）已完成的数量
    prisma.flowEvent.groupBy({ by: ['stepId'], where: { stepId: { in: steps.map((s) => s.id) }, type: { in: RETURN_TYPES } }, _sum: { qty: true } }),
  ])
  const done = new Map(sums.map((x) => [x.stepId, x._sum.qty ?? 0]))
  const now = new Date()
  return steps.map((s) => ({
    stepId: s.id,
    workOrderNumber: s.part.workOrderNumber,
    partName: s.part.name,
    drawingNo: s.part.drawingNo,
    quantity: s.part.quantity,
    doneQty: done.get(s.id) ?? 0,
    processName: names.process.get(s.processId) ?? s.processId,
    mode: s.mode,
    /** 厂内外协的班组，或自制派工的班组 */
    supplierId: s.supplierId,
    supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
    ownerId: s.ownerId,
    ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
    startedAt: s.startedAt,
    dueDate: s.dueDate,
    overdueDays: overdueDays(s.dueDate, now),
  }))
}
