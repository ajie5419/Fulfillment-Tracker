/**
 * 从 QMS 项目 BOM 导入工件和工序链（R8）。
 *
 * 规则只有几条：
 *   - 每个 BOM 行建一个工件（名称、图号 ← 图号、数量、qmsPartId ← QMS 零件 ID，报检据此匹配），qmsBomId 记 BOM 行 ID；
 *   - 必经工序按顺序建步骤，方式默认"自制"、不带外协厂和负责人，由外协专员事后补（页面标"待补充"）；
 *   - 工序在 QMS 没有关联工序 ID、或履约的工序副本里还没有（未同步/已删除）时跳过该道并给出提示——
 *     步骤只存工序 ID、名称靠副本翻译，建一个查不到名字的步骤只会让人看不懂；
 *   - 同一工单下已导入过的 BOM 行（按 qmsBomId）跳过；整批在一个事务里。
 *   - 按图号关联：工单里已有同图号、还没关联 QMS 的工件（一般是从技术部 BOM Excel 导入的）不再新建，
 *     只给它补上 BOM 行 ID、QMS 零件 ID（原来空着时），它还没有工序时按 QMS 建工序；名称、数量等不动。
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import type { QmsBomItem } from './client'
import { drawingKey } from './excel'

export interface BomPartPlan {
  qmsBomId: string
  part: { name: string; drawingNo: string | null; quantity: number; qmsPartId: string | null }
  processIds: string[]
}

/** 按图号关联到已有工件 */
export interface BomLinkPlan {
  qmsBomId: string
  partId: string
  qmsPartId: string | null
  /** 已有工件还没有工序时才建；有工序时为空 */
  processIds: string[]
}

/** 可以关联的已有工件：图号（drawingKey）→ 工件 */
export type LinkableParts = ReadonlyMap<string, { id: string; name: string; hasSteps: boolean }>

export interface BomImportPlan {
  create: BomPartPlan[]
  link: BomLinkPlan[]
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
export function planBomImport(
  rows: QmsBomItem[],
  selected: string[],
  imported: ReadonlySet<string>,
  known: ReadonlySet<string>,
  linkable: LinkableParts = new Map(),
  /** 已关联过 QMS 的工件：图号（drawingKey）→ 工件名称。同图号的新 QMS 行不再建工件 */
  linked: ReadonlyMap<string, string> = new Map(),
): BomImportPlan {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const plan: BomImportPlan = { create: [], link: [], skipped: [], missing: [], warnings: [] }
  const used = new Set<string>()
  for (const id of [...new Set(selected)]) {
    const row = byId.get(id)
    if (!row) plan.missing.push(id)
    else if (imported.has(id)) plan.skipped.push(id)
    else {
      const { plan: p, warnings } = mapBomRow(row, known)
      const key = drawingKey(row.partNumber)
      const target = key ? linkable.get(key) : undefined
      if (target && used.has(target.id)) {
        // QMS 里同一图号录了两行：第一行已关联，这行不再建，避免重复工件
        plan.skipped.push(id)
        plan.warnings.push(`${p.part.name}：图号 ${row.partNumber} 在 QMS 里录了不止一行，已关联到工件"${target.name}"，这行跳过`)
        continue
      }
      // 已关联的优先：同图号既有已关联、又有未关联的工件时也跳过，免得同一图号关联两次
      const takenBy = key ? linked.get(key) : undefined
      if (takenBy !== undefined) {
        // 同图号的工件已经关联过别的 QMS 行（比如上次导入时跳过的重复行）：仍然不建，避免重复工件
        plan.skipped.push(id)
        plan.warnings.push(`${p.part.name}：图号 ${row.partNumber} 已有关联 QMS 的工件"${takenBy}"，这行跳过`)
        continue
      }
      if (target) {
        used.add(target.id)
        plan.link.push({ qmsBomId: row.id, partId: target.id, qmsPartId: p.part.qmsPartId, processIds: target.hasSteps ? [] : p.processIds })
      } else plan.create.push(p)
      plan.warnings.push(...(target?.hasSteps ? [] : warnings))
    }
  }
  return plan
}

/** 工单里还没关联 QMS 的、带图号的工件 → 按图号索引 */
async function linkableParts(db: Pick<Prisma.TransactionClient, 'part'>, workOrderNumber: string) {
  const parts = await db.part.findMany({
    where: { workOrderNumber, qmsBomId: null, drawingNo: { not: null } },
    select: { id: true, name: true, drawingNo: true, fromTechBom: true, _count: { select: { steps: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const map = new Map<string, { id: string; name: string; hasSteps: boolean; fromTechBom: boolean }>()
  for (const p of parts) {
    const k = drawingKey(p.drawingNo)
    if (k && !map.has(k)) map.set(k, { id: p.id, name: p.name, hasSteps: p._count.steps > 0, fromTechBom: p.fromTechBom })
  }
  return map
}

/** 工单里已经关联 QMS 的、带图号的工件 → 按图号索引名称 */
async function linkedParts(db: Pick<Prisma.TransactionClient, 'part'>, workOrderNumber: string) {
  const parts = await db.part.findMany({
    where: { workOrderNumber, qmsBomId: { not: null }, drawingNo: { not: null } },
    select: { name: true, drawingNo: true },
    orderBy: { createdAt: 'asc' },
  })
  const map = new Map<string, string>()
  for (const p of parts) {
    const k = drawingKey(p.drawingNo)
    if (k && !map.has(k)) map.set(k, p.name)
  }
  return map
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

/**
 * 预览：QMS 的 BOM 行 + 每道工序能否建步骤 + 是否已导入 + 会关联到哪个已有工件；
 * 工单有技术部 BOM 时，再对照两边的图号（技术 BOM 有、QMS 没录的；QMS 有、技术 BOM 没有的），方便查录入差异。
 */
export async function previewBom(workOrderNumber: string, rows: QmsBomItem[]) {
  await assertWorkOrder(prisma, workOrderNumber)
  const [known, parts, linkable, linked, techParts] = await Promise.all([
    knownProcesses(prisma, allProcessIds(rows)),
    prisma.part.findMany({ where: { workOrderNumber, qmsBomId: { in: rows.map((r) => r.id) } }, select: { qmsBomId: true } }),
    linkableParts(prisma, workOrderNumber),
    linkedParts(prisma, workOrderNumber),
    prisma.part.findMany({ where: { workOrderNumber, fromTechBom: true }, select: { name: true, drawingNo: true, qmsBomId: true } }),
  ])
  const imported = new Set(parts.map((p) => p.qmsBomId))
  const qmsKeys = new Set(rows.map((r) => drawingKey(r.partNumber)).filter(Boolean))
  const techKeys = new Set(techParts.map((p) => drawingKey(p.drawingNo)).filter(Boolean))
  const hasTechBom = techParts.length > 0
  const items = rows.map((r) => ({
    bomId: r.id,
    partName: bomPartName(r),
    partNumber: r.partNumber,
    partId: r.partId,
    material: r.material,
    quantity: r.quantity,
    unit: r.unit,
    imported: imported.has(r.id),
    /** 导入时会关联到的已有工件（不新建） */
    linkTo: imported.has(r.id) || linked.has(drawingKey(r.partNumber)) ? null : (() => {
      const t = linkable.get(drawingKey(r.partNumber))
      return t ? { partId: t.id, name: t.name, hasSteps: t.hasSteps } : null
    })(),
    /** 同图号的工件已关联过别的 QMS 行：导入时跳过，不重复建 */
    duplicateOf: imported.has(r.id) ? null : (linked.get(drawingKey(r.partNumber)) ?? null),
    /** 工单有技术部 BOM、但里面没有这个图号 */
    notInTechBom: hasTechBom && !techKeys.has(drawingKey(r.partNumber)),
    processes: r.processes.map((p) => ({ processId: p.processId, processName: p.processName, problem: processProblem(p, known) })),
  }))
  const missingInQms = techParts
    .filter((p) => !qmsKeys.has(drawingKey(p.drawingNo)))
    .map((p) => ({ name: p.name, drawingNo: p.drawingNo }))
  return { items, hasTechBom, missingInQms }
}

/** 导入勾选的 BOM 行（整批一个事务）。rows 由路由在服务端从 QMS 实时读取，不用浏览器传来的内容 */
export async function importBom(workOrderNumber: string, rows: QmsBomItem[], selected: string[]) {
  if (!selected.length) throw new FlowError('请勾选要导入的零件')
  try {
    return await prisma.$transaction(async (tx) => {
      const ids = [...new Set(selected)]
      // 先锁工单行（工单还没有工件时，锁工件行锁不住任何东西），再锁工件行：和技术 BOM 导入、另一次 QMS 导入串行，按图号关联不会关联两次。
      // 加锁必须是事务里的第一次读：MySQL 可重复读下，第一次普通读就定下快照，锁之前读会看不到等锁期间别人刚提交的工件
      await tx.$queryRaw`SELECT workOrderNumber FROM qms_work_order WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM part WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
      await assertWorkOrder(tx, workOrderNumber)
      const [existing, known, linkable, linked] = await Promise.all([
        tx.part.findMany({ where: { workOrderNumber, qmsBomId: { in: ids } }, select: { qmsBomId: true } }),
        knownProcesses(tx, allProcessIds(rows)),
        linkableParts(tx, workOrderNumber),
        linkedParts(tx, workOrderNumber),
      ])
      const plan = planBomImport(rows, ids, new Set(existing.map((p) => p.qmsBomId!)), known, linkable, linked)
      let steps = 0
      const hasQmsPart = new Set(
        (await tx.part.findMany({ where: { id: { in: plan.link.map((l) => l.partId) }, qmsPartId: { not: null } }, select: { id: true } })).map((p) => p.id),
      )
      for (const l of plan.link) {
        await tx.part.update({
          where: { id: l.partId },
          data: {
            qmsBomId: l.qmsBomId,
            ...(hasQmsPart.has(l.partId) ? {} : { qmsPartId: l.qmsPartId }),
            ...(l.processIds.length ? { steps: { create: l.processIds.map((processId, i) => ({ seq: i + 1, processId, mode: 'SELF' as const })) } } : {}),
          },
        })
        steps += l.processIds.length
      }
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
      return { created: plan.create.length, linked: plan.link.length, steps, skipped: plan.skipped.length, missing: plan.missing.length, warnings: plan.warnings }
    })
  } catch (err) {
    // 两个人同时导入同一行：唯一约束 (workOrderNumber, qmsBomId) 拦下，整批回滚
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new FlowError('有人正在导入这个工单的 BOM，请刷新后重试')
    throw err
  }
}
