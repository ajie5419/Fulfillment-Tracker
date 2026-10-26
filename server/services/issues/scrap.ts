/**
 * 完工时报废 → 自动生成一条"车间"异常（来源：报废），默认责任人是生产部负责人（生产经理），由他安排补料重做。
 * 幂等键 SCRAP:<报废事件 ID>。调用方（finish.ts）负责开事务，与报废事件、完工在同一事务里。
 */
import type { Part, Prisma, RouteStep } from '@prisma/client'
import { loadNames } from '../flow/names'
import { createSystemIssue } from './issues'

type Tx = Prisma.TransactionClient

export const scrapSourceKey = (eventId: string) => `SCRAP:${eventId}`

export async function createScrapIssue(
  tx: Tx,
  step: RouteStep & { part: Part },
  input: { eventId: string; scrapQty: number; doneQty: number; note: string | null; actorId: string },
) {
  const names = await loadNames({ process: [step.processId], supplier: [step.supplierId] })
  const processName = names.process.get(step.processId) ?? step.processId
  const team = step.supplierId ? `（${names.supplier.get(step.supplierId) ?? step.supplierId}）` : ''
  const reason = input.note ? `，原因：${input.note}` : ''
  return createSystemIssue(tx, {
    sourceKey: scrapSourceKey(input.eventId),
    source: 'SCRAP',
    category: 'WORKSHOP',
    workOrderNumber: step.part.workOrderNumber,
    refType: 'STEP',
    refId: step.id,
    // 报废的人确认关闭：补料重做安排好了由他确认
    reporterId: input.actorId,
    actorId: input.actorId,
    description: `${step.part.name} · ${processName}${team}完工 ${input.doneQty} 件，报废 ${input.scrapQty} 件${reason}。请安排补料重做`,
    note: `完工时报废 ${input.scrapQty} 件，自动生成`,
  })
}
