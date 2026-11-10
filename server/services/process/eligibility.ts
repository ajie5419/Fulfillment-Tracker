import type { Prisma } from '@prisma/client'
import { PROCUREMENT_PLAN_NODE_MARKER, requiresProcessForNode } from '../../../shared/process'

/** Preserve standalone drawing tasks; procurement planning does not require manufacturing documents. */
export const processTaskWhere: Prisma.DrawingTaskWhereInput = {
  OR: [
    { planNodeId: null },
    { planNode: { is: { NOT: { name: { contains: PROCUREMENT_PLAN_NODE_MARKER } } } } },
  ],
}

export async function taskRequiresProcess(tx: Prisma.TransactionClient, planNodeId: string | null) {
  if (!planNodeId) return true
  const node = await tx.planNode.findUnique({ where: { id: planNodeId }, select: { name: true } })
  return requiresProcessForNode(node?.name)
}
