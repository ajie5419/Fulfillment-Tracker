import { prisma } from '../../utils/prisma'
import { ensureDemoIdentity } from './demo-identity'
import { deptHeads, loadPlans } from '../plan/plan'
import { CONFIRM_PLAN_NODE, PLAN_REF } from '../plan/constants'

/** Called only by the isolated demo launcher, before serving requests.
 * Repair missing recipients without resetting dates, acceptance or existing todos.
 * The plan lock makes repeated repairs safe against concurrent plan operations.
 */
export async function repairIsolatedDemo() {
  await prisma.$transaction((tx) => ensureDemoIdentity(tx))
  const plans = await prisma.workOrderPlan.findMany({ where: { workOrderNumber: { startsWith: 'DEMO-' }, status: 'PUBLISHED' }, select: { workOrderNumber: true } })
  let created = 0
  for (const { workOrderNumber } of plans) {
    created += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT workOrderNumber FROM work_order_plan WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
      const data = (await loadPlans({ workOrderNumbers: [workOrderNumber], publishedOnly: true }, new Date(), tx)).get(workOrderNumber)
      if (!data) return 0
      const parents = new Set(data.nodes.map((n) => n.parentId))
      const completed = new Set(data.forecast.nodes.filter((n) => n.done).map((n) => n.id))
      let added = 0
      for (const node of data.nodes) {
        if (node.confirmStatus !== 'PENDING' || parents.has(node.id) || completed.has(node.id)) continue
        const owners = await deptHeads(tx, node.dept)
        const existing = await tx.todo.findMany({ where: { refType: PLAN_REF, refId: node.id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, select: { ownerId: true } })
        const missing = owners.filter((ownerId) => !existing.some((t) => t.ownerId === ownerId))
        if (missing.length) added += (await tx.todo.createMany({ data: missing.map((ownerId) => ({ ownerId, action: CONFIRM_PLAN_NODE, refType: PLAN_REF, refId: node.id })) })).count
      }
      return added
    })
  }
  return { created }
}
