/**
 * 部门记录挂总计划节点（R14 总计划设计第 4 节）：出图任务、采购行、工序、装配节点的新建 / 编辑共用的校验和提示。
 *
 *   节点只能选同一工单的；
 *   工单已发布总计划时，新建必须选节点（系统自动生成的记录——BOM 导入、套模板、复制路线、Excel 导入——不走这里，不受影响）；
 *   已挂了节点的记录在已发布的工单上不能改成"不挂"（可以改挂别的节点）；老数据（没挂）照旧可以不挂；
 *   部门日期晚于节点计划日：照样保存，返回提示（planWarning），总计划页标红。
 * 只读 plan_node / work_order_plan，不加锁（写记录时外键检查会给节点行加共享锁）。
 */
import type { Prisma } from '@prisma/client'
import { FlowError } from '../flow/errors'
import { lateWarning } from './constants'

type Db = Pick<Prisma.TransactionClient, 'planNode' | 'workOrderPlan'>

export interface LinkedNode {
  id: string
  name: string
  /** 'YYYY-MM-DD' */
  planDay: string
}

/**
 * 校验并返回要挂的节点。
 *   planNodeId：undefined = 不改（编辑时）；null / '' = 不挂；
 *   creating：新建（已发布的工单必须选）；
 *   oldNodeId：编辑时原来挂的节点。
 * 返回最终挂的节点（不挂为 null）和要写进记录的值（undefined = 不改）。
 */
export async function resolvePlanNode(
  db: Db,
  workOrderNumber: string,
  planNodeId: string | null | undefined,
  opts: { creating: boolean; oldNodeId?: string | null },
): Promise<{ node: LinkedNode | null; value: string | null | undefined }> {
  const id = planNodeId === undefined ? undefined : planNodeId || null
  if (id) {
    const n = await db.planNode.findUnique({ where: { id }, select: { id: true, name: true, planDate: true, workOrderNumber: true } })
    if (!n || n.workOrderNumber !== workOrderNumber) throw new FlowError('总计划节点不存在或不属于该工单')
    return { node: { id: n.id, name: n.name, planDay: n.planDate.toISOString().slice(0, 10) }, value: id }
  }
  const published = async () =>
    (await db.workOrderPlan.findUnique({ where: { workOrderNumber }, select: { status: true } }))?.status === 'PUBLISHED'
  if (opts.creating) {
    if (await published()) throw new FlowError('该工单已发布总计划，请选择所属总计划节点')
    return { node: null, value: null }
  }
  if (id === null && opts.oldNodeId && (await published())) throw new FlowError('该工单已发布总计划，已挂节点的记录不能改成不挂（可以改挂其他节点）')
  // 不改：带出原来的节点（算提示用）
  const keep = id === undefined ? opts.oldNodeId : null
  if (!keep) return { node: null, value: id }
  const n = await db.planNode.findUnique({ where: { id: keep }, select: { id: true, name: true, planDate: true } })
  return { node: n ? { id: n.id, name: n.name, planDay: n.planDate.toISOString().slice(0, 10) } : null, value: undefined }
}

/** 部门日期晚于节点计划日的提示；不晚、没挂节点或没日期时为 null */
export function planWarning(what: string, recordDate: Date | null | undefined, node: LinkedNode | null): string | null {
  return lateWarning(what, recordDate ? recordDate.toISOString().slice(0, 10) : null, node)
}
