import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames, userDepartmentNames } from '../flow/names'
import { CONFIRM_CHANGE, partIdsOf } from './constants'

export async function partNames(partIds: string[]) {
  if (!partIds.length) return new Map<string, { name: string; drawingNo: string | null }>()
  const parts = await prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true, drawingNo: true } })
  return new Map(parts.map((p) => [p.id, { name: p.name, drawingNo: p.drawingNo }]))
}

/** 发放单详情：内容、附件、每个接收人的签收状态、设计变更影响的工序，以及当前用户能做的操作 */
export async function loadReleaseView(id: string) {
  const rel = await prisma.release.findUnique({ where: { id }, include: { receipts: { orderBy: { createdAt: 'asc' } } } })
  if (!rel) throw new FlowError('发放单不存在')
  const partIds = partIdsOf(rel.partIds)
  const [parts, attachments, confirmTodos, wo] = await Promise.all([
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, include: { steps: { orderBy: { seq: 'asc' } } } }) : [],
    prisma.uploadFile.findMany({ where: { releaseId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, mime: true, size: true } }),
    prisma.todo.findMany({ where: { refType: 'release', refId: id, action: CONFIRM_CHANGE }, orderBy: { createdAt: 'asc' } }),
    prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber: rel.workOrderNumber }, select: { projectName: true, customerName: true } }),
  ])
  const steps = parts.flatMap((p) => p.steps)
  const userIds = [rel.issuerId, rel.changeConfirmedBy, ...rel.receipts.map((r) => r.userId), ...confirmTodos.map((t) => t.ownerId)]
  const [names, deptOf] = await Promise.all([
    loadNames({ user: userIds, process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) }),
    userDepartmentNames(rel.receipts.map((r) => r.userId)),
  ])
  return { rel, partIds, parts, attachments, confirmTodos, wo, steps, names, deptOf }
}
