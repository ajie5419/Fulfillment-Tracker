/**
 * QMS 不合格转异常（验收 A7）。
 *
 * 判定：qms_inspection.status = 'CLOSED' 且 inspectionResult = 'FAIL'（QMS 的检验结论默认是 PASS，
 * 只看 FAIL 会把还没检验的也算进去，所以必须同时是已关闭）。
 * 只处理已经记过返厂（flow_event.qmsInspectionId）的报检：没匹配上的报检人工关联后，下一轮扫描同样能扫到。
 * 生成：来源 QMS 不合格、分类 外协-质量、责任方 = 报检的外协单位、责任部门 = 质量部（分类默认）、
 * 关联该工序步骤（refType STEP），同一事务内步骤置为"有异常"。
 * 幂等：issue.sourceKey = "QMS:<报检 ID>" 唯一，重复扫描、并发扫描撞唯一键都当作已存在。
 */
import { prisma } from '../../utils/prisma'
import { blockStep } from '../flow/flow'
import { loadNames } from '../flow/names'
import { createSystemIssue, isSourceKeyConflict, issueTransaction } from './issues'

export const qmsSourceKey = (inspectionId: string) => `QMS:${inspectionId}`

export interface NonconformingResult {
  created: { inspectionId: string; issueId: string; issueNo: string; stepId: string }[]
  existed: number
}

export async function syncNonconforming(): Promise<NonconformingResult> {
  const rows = await prisma.$queryRaw<{ id: string; stepId: string }[]>`
    SELECT i.id, f.stepId FROM qms_inspection i
    JOIN flow_event f ON f.qmsInspectionId = i.id
    LEFT JOIN issue x ON x.sourceKey = CONCAT('QMS:', i.id)
    WHERE i.isDeleted = false AND i.status = 'CLOSED' AND i.inspectionResult = 'FAIL' AND x.id IS NULL
    ORDER BY i.closedAt, i.id`
  const result: NonconformingResult = { created: [], existed: 0 }
  for (const row of rows) {
    try {
      const issue = await issueTransaction(async (tx) => {
        const ins = await tx.qmsInspection.findUniqueOrThrow({ where: { id: row.id } })
        const step = await tx.routeStep.findUniqueOrThrow({ where: { id: row.stepId }, include: { part: true } })
        const supplierId = ins.supplierId ?? step.supplierId
        const names = await loadNames({ process: [step.processId], supplier: [supplierId] })
        const supplier = supplierId ? (names.supplier.get(supplierId) ?? ins.supplierName ?? supplierId) : (ins.supplierName ?? '外协单位')
        const unq = ins.unqualifiedQuantity != null ? `不合格 ${ins.unqualifiedQuantity} 件` : '不合格数量未填'
        const issue = await createSystemIssue(tx, {
          sourceKey: qmsSourceKey(ins.id),
          source: 'QMS_NONCONFORMING',
          category: 'OUTSOURCE_QUALITY',
          workOrderNumber: step.part.workOrderNumber,
          refType: 'STEP',
          refId: step.id,
          responsibleSupplierId: supplierId,
          description: `QMS 报检单 ${ins.requestNo} 检验不合格：${step.part.name} · ${names.process.get(step.processId) ?? ins.processName}（${supplier}），报检 ${ins.quantity} 件，${unq}`,
          note: `QMS 检验不合格自动生成（报检单 ${ins.requestNo}）`,
        })
        await blockStep(tx, step.id)
        return issue
      })
      result.created.push({ inspectionId: row.id, issueId: issue.id, issueNo: issue.issueNo, stepId: row.stepId })
    } catch (err) {
      if (!isSourceKeyConflict(err)) throw err
      result.existed++
    }
  }
  return result
}
