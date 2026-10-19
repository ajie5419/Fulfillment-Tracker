/** 外协在途：已发出（OUT）还没全部返回的步骤。 */
import { prisma } from '../../utils/prisma'
import { overdueDays } from './dates'
import { loadNames } from './names'

/** visibleWorkOrders：可见工单（undefined = 全部，见 server/utils/auth.ts 的 getScope） */
export async function listTransit(filter: { workOrderNumber?: string; supplierId?: string; visibleWorkOrders?: string[] }) {
  const wo = {
    ...(filter.workOrderNumber ? { equals: filter.workOrderNumber } : {}),
    ...(filter.visibleWorkOrders ? { in: filter.visibleWorkOrders } : {}),
  }
  const steps = await prisma.routeStep.findMany({
    where: {
      status: 'OUT',
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(Object.keys(wo).length ? { part: { workOrderNumber: wo } } : {}),
    },
    include: { part: true },
    orderBy: [{ promisedReturnDate: 'asc' }, { startedAt: 'asc' }],
  })
  const [names, sums] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId), user: steps.map((s) => s.ownerId) }),
    prisma.flowEvent.groupBy({
      by: ['stepId'],
      where: { stepId: { in: steps.map((s) => s.id) }, type: { in: ['RETURN', 'RETURN_MANUAL'] } },
      _sum: { qty: true },
    }),
  ])
  const returned = new Map(sums.map((s) => [s.stepId, s._sum.qty ?? 0]))
  const now = new Date()
  return steps.map((s) => ({
    stepId: s.id,
    seq: s.seq,
    workOrderNumber: s.part.workOrderNumber,
    partId: s.partId,
    partName: s.part.name,
    qmsPartId: s.part.qmsPartId,
    quantity: s.part.quantity,
    returnedQty: returned.get(s.id) ?? 0,
    processId: s.processId,
    processName: names.process.get(s.processId) ?? s.processId,
    supplierId: s.supplierId,
    supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
    ownerId: s.ownerId,
    ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
    startedAt: s.startedAt,
    promisedReturnDate: s.promisedReturnDate,
    overdueDays: overdueDays(s.promisedReturnDate, now),
  }))
}

/** 当前用户最近一次发出用的外协厂，作为发出登记的默认值 */
export async function lastSupplierOf(userId: string) {
  const ev = await prisma.flowEvent.findFirst({
    where: { actorId: userId, type: 'SEND' },
    orderBy: { occurredAt: 'desc' },
    select: { step: { select: { supplierId: true } } },
  })
  return ev?.step.supplierId ?? null
}
