import type { H3Event } from 'h3'
import { prisma } from './prisma'
import { FlowError } from '../services/flow/errors'
import { assertCanOperate, assertCanSee } from './auth'

/** 批量编排：勾选的工件都要存在、可见，且当前用户能编辑它们所属工单的工序（route） */
export async function assertBatchParts(event: H3Event, partIds: string[]) {
  const ids = [...new Set(partIds)]
  const parts = await prisma.part.findMany({ where: { id: { in: ids } }, select: { id: true, workOrderNumber: true } })
  if (parts.length !== ids.length) throw new FlowError('有工件不存在或已删除，请刷新后重试')
  for (const wo of new Set(parts.map((p) => p.workOrderNumber))) {
    await assertCanSee(event, wo)
    await assertCanOperate(event, 'route', { workOrderNumber: wo })
  }
}
