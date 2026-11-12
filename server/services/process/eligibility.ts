import type { Prisma } from '@prisma/client'
import { requiresProcessForNode } from '../../../shared/process'

/** Eligibility follows the stored policy; changing a label cannot reroute a task. */
export const processTaskWhere: Prisma.DrawingTaskWhereInput = {
  OR: [
    { planNodeId: null },
    { planNode: { is: { requiresProcess: true } } },
  ],
}

export async function taskRequiresProcess(tx: Prisma.TransactionClient, planNodeId: string | null) {
  if (!planNodeId) return true
  const node = await tx.planNode.findUnique({ where: { id: planNodeId }, select: { requiresProcess: true } })
  return requiresProcessForNode(node)
}
