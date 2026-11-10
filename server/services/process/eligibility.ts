import type { Prisma } from '@prisma/client'
import { PROCUREMENT_PLAN_NODE_MARKER, PROCESS_EXCLUDED_NODE_NAMES, requiresProcessForNode } from '../../../shared/process'

/** Preserve drawing tasks; procurement planning and commissioning do not require manufacturing documents. */
export const processTaskWhere: Prisma.DrawingTaskWhereInput = {
  OR: [
    { planNodeId: null },
    { planNode: { is: { NOT: [
      { name: { contains: PROCUREMENT_PLAN_NODE_MARKER } },
      { name: { in: [...PROCESS_EXCLUDED_NODE_NAMES] } },
    ] } } },
  ],
}

export async function taskRequiresProcess(tx: Prisma.TransactionClient, planNodeId: string | null) {
  if (!planNodeId) return true
  const node = await tx.planNode.findUnique({ where: { id: planNodeId }, select: { name: true } })
  return requiresProcessForNode(node?.name)
}
