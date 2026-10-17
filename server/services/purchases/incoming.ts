/**
 * QMS 进货检验（INCOMING）→ 采购行自动确认到货（R10）。同步任务每轮报检同步成功后调用，演示工具也调用。
 *
 * 匹配规则见 constants.ts findPurchaseCandidates（工单 + 物料名称，两边都有 QMS 供应商 ID 时还要供应商相同，报检不早于登记日）。
 * 恰好一条 → 记到货（到货日 = 报检提交日，来源 QMS 进货检验）；零条或多条 → 不动，留给手工确认。
 * 每条报检只自动处理一次（incoming_check 记结果），所以手工处理过多候选之后，同一条报检不会再"对上剩下那条"。
 *
 * 只看有采购行的工单上的报检：QMS 全量同步过来的其他报检不处理、也不记录（之后建了采购行，登记前的报检本来也不算）。
 * 撤销（CANCELLED）的报检不处理；已经自动到货后 QMS 再撤销报检的，到货不回退（实物已到，有问题人工撤销到货）。
 * 只按"报检提交"认定到货，不看检验结论、不看数量（关键物料一般整批到，分批到的以第一批为准）。
 */
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { inspectionWorkOrders } from '../flow/inspection'
import { findPurchaseCandidates, isIncomingInspection, todayDate } from './constants'
import { applyArrival, lockLine, purchaseTx } from './purchases'

export interface IncomingResult {
  inspectionId: string
  result: 'MATCHED' | 'NO_CANDIDATE' | 'MULTIPLE' | 'SKIPPED'
  purchaseLineId?: string
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'

/** 处理一条进货检验（自带事务）。已处理过、不是进货检验、已撤销的返回 SKIPPED */
export async function matchIncoming(inspectionId: string): Promise<IncomingResult> {
  try {
    return await purchaseTx(async (tx): Promise<IncomingResult> => {
      // 先占住这条报检：并发的另一轮处理同一条时，后到的撞主键直接跳过
      const done = await tx.incomingCheck.findUnique({ where: { qmsInspectionId: inspectionId } })
      if (done) return { inspectionId, result: 'SKIPPED' }
      const ins = await tx.qmsInspection.findUnique({ where: { id: inspectionId } })
      if (!ins || ins.isDeleted || ins.status === 'CANCELLED' || !isIncomingInspection(ins)) return { inspectionId, result: 'SKIPPED' }
      const lines = await tx.purchaseLine.findMany({ where: { workOrderNumber: { in: inspectionWorkOrders(ins) }, status: 'OPEN', qmsInspectionId: null } })
      const hits = findPurchaseCandidates(ins, lines)
      if (hits.length !== 1) {
        const result = hits.length ? 'MULTIPLE' : 'NO_CANDIDATE'
        await tx.incomingCheck.create({ data: { qmsInspectionId: inspectionId, result } })
        return { inspectionId, result }
      }
      // 先锁工件再锁采购行，读最新数据复核（同时有人手工确认 / 取消时以先提交的为准）
      const line = await lockLine(tx, hits[0]!.id)
      if (line.status !== 'OPEN' || line.qmsInspectionId) {
        await tx.incomingCheck.create({ data: { qmsInspectionId: inspectionId, result: 'NO_CANDIDATE' } })
        return { inspectionId, result: 'NO_CANDIDATE' }
      }
      // 到货日 = 报检提交那天（工厂时区）
      const arrivedDate = todayDate(ins.submittedAt)
      await tx.incomingCheck.create({ data: { qmsInspectionId: inspectionId, result: 'MATCHED', purchaseLineId: line.id } })
      try {
        await applyArrival(tx, line, { arrivedDate, source: 'QMS_INSPECTION', qmsInspectionId: ins.id }, null)
      } catch (err) {
        // 报检日期在"今天"之后（服务器时钟偏差）等：不自动确认
        if (err instanceof FlowError) throw new SkipMatch()
        throw err
      }
      return { inspectionId, result: 'MATCHED', purchaseLineId: line.id }
    })
  } catch (err) {
    if (err instanceof SkipMatch || isUniqueViolation(err)) return { inspectionId, result: 'SKIPPED' }
    throw err
  }
}

class SkipMatch extends Error {}

/**
 * 处理所有还没处理过的进货检验：未删除、未撤销、还没记过结果，且主工单或任一关联工单上有采购行。
 * 按提交时间先后处理（同一行对上两条报检时，先到的那条确认到货）。
 */
export async function matchIncomingInspections(): Promise<IncomingResult[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM qms_inspection i
    LEFT JOIN incoming_check c ON c.qmsInspectionId = i.id
    WHERE c.qmsInspectionId IS NULL
      AND i.isDeleted = false
      AND i.status <> 'CANCELLED'
      AND (UPPER(TRIM(COALESCE(i.category, ''))) = 'INCOMING' OR (TRIM(COALESCE(i.category, '')) = '' AND TRIM(i.processName) = '进货检验'))
      AND EXISTS (
        SELECT 1 FROM purchase_line p
        WHERE p.workOrderNumber = i.workOrderNumber
          OR (i.workOrderNumbers IS NOT NULL AND JSON_CONTAINS(i.workOrderNumbers, JSON_QUOTE(p.workOrderNumber))))
    ORDER BY i.submittedAt, i.id`
  const out: IncomingResult[] = []
  for (const { id } of rows) out.push(await matchIncoming(id))
  return out
}
