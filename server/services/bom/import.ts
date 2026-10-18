/**
 * 从 QMS 项目 BOM 导入工件和工序链（R8）。
 *
 * 规则只有几条：
 *   - 每个 BOM 行建一个工件（名称、图号 ← 图号、数量、qmsPartId ← QMS 零件 ID，报检据此匹配），qmsBomId 记 BOM 行 ID；
 *   - 必经工序按顺序建步骤，方式默认"自制"、不带外协厂和负责人，由外协专员事后补（页面标"待补充"）；
 *   - 工序在 QMS 没有关联工序 ID、或履约的工序副本里还没有（未同步/已删除）时跳过该道并给出提示——
 *     步骤只存工序 ID、名称靠副本翻译，建一个查不到名字的步骤只会让人看不懂；
 *   - 同一工单下已导入过的 BOM 行（按 qmsBomId）跳过，绝不修改已有工件；整批在一个事务里。
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import type { QmsBomItem } from './client'

export interface BomPartPlan {
  qmsBomId: string
  part: { name: string; drawingNo: string | null; quantity: number; qmsPartId: string | null }
  processIds: string[]
}

export interface BomImportPlan {
  create: BomPartPlan[]
  /** 已导入过、本次跳过的 BOM 行 */
  skipped: string[]
  /** 勾选了但 QMS 里已经没有的 BOM 行（预览后被删了） */
  missing: string[]
  warnings: string[]
}

const clip = (v: string | null | undefined, max: number) => {
  const t = v?.trim()
  return t ? t.slice(0, max) : null
}

export const bomPartName = (row: Pick<QmsBomItem, 'partName' | 'id'>) => clip(row.partName, 191) ?? `BOM 行 ${row.id}`

/** 一道 BOM 工序在履约能不能建步骤；不能时给出原因 */
export function processProblem(p: QmsBomItem['processes'][number], known: ReadonlySet<string>): string | null {
  if (!p.processId) return '在 QMS 没有关联工序'
  if (!known.has(p.processId)) return '在履约还没有同步到'
  return null
}

/** 单个 BOM 行 → 工件 + 工序（纯函数） */
export function mapBomRow(row: QmsBomItem, known: ReadonlySet<string>): { plan: BomPartPlan; warnings: string[] } {
  const name = bomPartName(row)
  const warnings: string[] = []
  const processIds: string[] = []
  for (const p of row.processes) {
    const problem = processProblem(p, known)
    if (problem) warnings.push(`${name}：工序"${p.processName || p.processId || '未命名'}"${problem}，已跳过`)
    else processIds.push(p.processId!)
  }
  return {
    plan: {
      qmsBomId: row.id,
      part: {
        name,
        drawingNo: clip(row.partNumber, 191),
        quantity: Math.min(Math.max(row.quantity, 1), 100000),
        qmsPartId: clip(row.partId, 64),
      },
      processIds,
    },
    warnings,
  }
}

/** 勾选的行 → 导入计划（纯函数）：已导入的跳过，QMS 里已没有的单列 */
export function planBomImport(rows: QmsBomItem[], selected: string[], imported: ReadonlySet<string>, known: ReadonlySet<string>): BomImportPlan {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const plan: BomImportPlan = { create: [], skipped: [], missing: [], warnings: [] }
  for (const id of [...new Set(selected)]) {
    const row = byId.get(id)
    if (!row) plan.missing.push(id)
    else if (imported.has(id)) plan.skipped.push(id)
    else {
      const { plan: p, warnings } = mapBomRow(row, known)
      plan.create.push(p)
      plan.warnings.push(...warnings)
    }
  }
  return plan
}

const allProcessIds = (rows: QmsBomItem[]) => [...new Set(rows.flatMap((r) => r.processes.map((p) => p.processId)).filter((x): x is string => !!x))]

async function knownProcesses(db: Pick<Prisma.TransactionClient, 'qmsProcess'>, ids: string[]) {
  if (!ids.length) return new Set<string>()
  const rows = await db.qmsProcess.findMany({ where: { id: { in: ids }, isDeleted: false }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

async function assertWorkOrder(db: Pick<Prisma.TransactionClient, 'qmsWorkOrder'>, workOrderNumber: string) {
  const wo = await db.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
}

/** 预览：QMS 的 BOM 行 + 每道工序能否建步骤 + 是否已导入 */
export async function previewBom(workOrderNumber: string, rows: QmsBomItem[]) {
  await assertWorkOrder(prisma, workOrderNumber)
  const [known, parts] = await Promise.all([
    knownProcesses(prisma, allProcessIds(rows)),
    prisma.part.findMany({ where: { workOrderNumber, qmsBomId: { in: rows.map((r) => r.id) } }, select: { qmsBomId: true } }),
  ])
  const imported = new Set(parts.map((p) => p.qmsBomId))
  return rows.map((r) => ({
    bomId: r.id,
    partName: bomPartName(r),
    partNumber: r.partNumber,
    partId: r.partId,
    material: r.material,
    quantity: r.quantity,
    unit: r.unit,
    imported: imported.has(r.id),
    processes: r.processes.map((p) => ({ processId: p.processId, processName: p.processName, problem: processProblem(p, known) })),
  }))
}

/** 导入勾选的 BOM 行（整批一个事务）。rows 由路由在服务端从 QMS 实时读取，不用浏览器传来的内容 */
export async function importBom(workOrderNumber: string, rows: QmsBomItem[], selected: string[]) {
  if (!selected.length) throw new FlowError('请勾选要导入的零件')
  try {
    return await prisma.$transaction(async (tx) => {
      await assertWorkOrder(tx, workOrderNumber)
      const ids = [...new Set(selected)]
      const [existing, known] = await Promise.all([
        tx.part.findMany({ where: { workOrderNumber, qmsBomId: { in: ids } }, select: { qmsBomId: true } }),
        knownProcesses(tx, allProcessIds(rows)),
      ])
      const plan = planBomImport(rows, ids, new Set(existing.map((p) => p.qmsBomId!)), known)
      let steps = 0
      for (const p of plan.create) {
        await tx.part.create({
          data: {
            workOrderNumber,
            ...p.part,
            qmsBomId: p.qmsBomId,
            steps: { create: p.processIds.map((processId, i) => ({ seq: i + 1, processId, mode: 'SELF' as const })) },
          },
        })
        steps += p.processIds.length
      }
      return { created: plan.create.length, steps, skipped: plan.skipped.length, missing: plan.missing.length, warnings: plan.warnings }
    })
  } catch (err) {
    // 两个人同时导入同一行：唯一约束 (workOrderNumber, qmsBomId) 拦下，整批回滚
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new FlowError('有人正在导入这个工单的 BOM，请刷新后重试')
    throw err
  }
}
