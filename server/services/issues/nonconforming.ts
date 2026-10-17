/**
 * QMS 不合格转异常（验收 A7）。
 *
 * 判定（按 QMS 实际行为）：inspectionResult = 'FAIL'，或 linkedIssueId / linkedIssueNo 非空（关联了 QMS 质量问题单），
 * 且 status ≠ CANCELLED、未删除。QMS 判不合格时写 inspectionResult=FAIL，但 status 仍是 INSPECTING、closedAt 为空；
 * 复检合格后会被覆盖成 CLOSED+PASS，"曾经不合格"只能靠 linkedIssueId/No 识别。inspectionResult 默认 PASS，
 * 所以 PASS 不代表已检合格，也不能用 CLOSED 作为判不合格的前提。
 * 已生成的异常不因之后改回 PASS 而撤销（由人走异常闭环关闭）。
 * 只处理已经记过返厂（flow_event.qmsInspectionId）的报检：没匹配上的报检人工关联后，下一轮同样能扫到。
 * 生成：来源 QMS 不合格、分类 外协-质量、责任方 = 报检的外协单位（供应商，没有时为厂内外协班组）、责任部门 = 质量部（分类默认）、
 * 关联该工序步骤（refType STEP），同一事务内步骤置为"有异常"。
 * 幂等：issue.sourceKey = "QMS:<报检 ID>" 唯一，重复扫描、并发扫描撞唯一键都当作已存在。
 */
import { prisma } from '../../utils/prisma'
import { blockStep } from '../flow/flow'
import { inspectionSupplierId } from '../flow/inspection'
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
    WHERE i.isDeleted = false AND i.status <> 'CANCELLED' AND x.id IS NULL
      AND (i.inspectionResult = 'FAIL' OR i.linkedIssueId IS NOT NULL OR i.linkedIssueNo IS NOT NULL)
    ORDER BY i.updatedAt, i.id`
  const result: NonconformingResult = { created: [], existed: 0 }
  for (const row of rows) {
    try {
      const issue = await issueTransaction(async (tx) => {
        const ins = await tx.qmsInspection.findUniqueOrThrow({ where: { id: row.id } })
        const step = await tx.routeStep.findUniqueOrThrow({ where: { id: row.stepId }, include: { part: true } })
        const supplierId = inspectionSupplierId(ins) ?? step.supplierId
        const names = await loadNames({ process: [step.processId], supplier: [supplierId] })
        const insSupplierName = ins.supplierName ?? ins.teamName
        const supplier = supplierId ? (names.supplier.get(supplierId) ?? insSupplierName ?? supplierId) : (insSupplierName ?? '外协单位')
        const unq = ins.unqualifiedQuantity != null ? `不合格 ${ins.unqualifiedQuantity} 件` : '不合格数量未填'
        const qmsIssue = ins.linkedIssueNo ? `，QMS 问题单 ${ins.linkedIssueNo}` : ''
        const issue = await createSystemIssue(tx, {
          sourceKey: qmsSourceKey(ins.id),
          source: 'QMS_NONCONFORMING',
          category: 'OUTSOURCE_QUALITY',
          workOrderNumber: step.part.workOrderNumber,
          refType: 'STEP',
          refId: step.id,
          responsibleSupplierId: supplierId,
          description: `QMS 报检单 ${ins.requestNo} 检验不合格：${step.part.name} · ${names.process.get(step.processId) ?? ins.processName}（${supplier}），报检 ${ins.quantity} 件，${unq}${qmsIssue}`,
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
