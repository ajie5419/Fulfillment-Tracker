/**
 * 工序路线模板（R8）：一串工序 + 每道的执行方式、默认外协厂、默认工期。
 * 套用 = 把步骤复制到工件上（只给还没有工序的工件），之后改模板不影响已套用的工件——复制就是版本。
 * 模板的增删改只有管理员能做（路由层校验）；套用跟着工件编辑权限走。
 */
import { Prisma, type StepMode } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { parseDay } from '../flow/dates'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'

type Tx = Prisma.TransactionClient

export interface TemplateStepInput {
  processId: string
  mode: StepMode
  supplierId?: string | null
  defaultDays?: number | null
}

export interface TemplateInput {
  name: string
  description?: string | null
  steps: TemplateStepInput[]
}

const DAY_MS = 86_400_000

/**
 * 模板步骤 → 工件步骤（纯函数）。自制不带外协厂。
 * 给了开工日（startDay，YYYY-MM-DD）时，按默认工期逐道累加日历天得出要求完成日；没填工期的那道不设日期、也不占天数。
 * 不给开工日就都不设日期——要求完成日过了会直接触发 W3 红色预警，不能替人编日期。
 */
export function routeFromTemplate(steps: TemplateStepInput[], startDay?: string | null) {
  let cursor = startDay ? parseDay(startDay).getTime() : null
  return steps.map((s, i) => {
    let dueDate: Date | null = null
    if (cursor !== null && s.defaultDays != null) {
      cursor += s.defaultDays * DAY_MS
      dueDate = new Date(cursor)
    }
    return { seq: i + 1, processId: s.processId, mode: s.mode, supplierId: s.mode === 'SELF' ? null : s.supplierId || null, dueDate }
  })
}

async function assertSteps(tx: Tx, steps: TemplateStepInput[]) {
  if (!steps.length) throw new FlowError('模板至少要有一道工序')
  const ids = [...new Set(steps.map((s) => s.processId))]
  const found = await tx.qmsProcess.count({ where: { id: { in: ids }, isDeleted: false } })
  if (found !== ids.length) throw new FlowError('模板里有工序不存在或已停用')
}

const stepRows = (steps: TemplateStepInput[]) =>
  steps.map((s, i) => ({
    seq: i + 1,
    processId: s.processId,
    mode: s.mode,
    supplierId: s.mode === 'SELF' ? null : s.supplierId || null,
    defaultDays: s.defaultDays ?? null,
  }))

/** 名称重复（唯一约束）转成中文提示 */
async function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new FlowError('模板名称已存在，换一个名称')
    throw err
  }
}

export async function listTemplates() {
  const rows = await prisma.routeTemplate.findMany({ orderBy: { name: 'asc' }, include: { steps: { orderBy: { seq: 'asc' } } } })
  const steps = rows.flatMap((t) => t.steps)
  const names = await loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId), user: rows.map((t) => t.createdBy) })
  return rows.map((t) => ({
    ...t,
    createdByName: t.createdBy ? (names.user.get(t.createdBy) ?? t.createdBy) : null,
    steps: t.steps.map((s) => ({
      ...s,
      processName: names.process.get(s.processId) ?? s.processId,
      supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
    })),
  }))
}

export async function createTemplate(input: TemplateInput, actorId: string) {
  return uniqueName(() =>
    prisma.$transaction(async (tx) => {
      await assertSteps(tx, input.steps)
      return tx.routeTemplate.create({
        data: { name: input.name.trim(), description: input.description?.trim() || null, createdBy: actorId, steps: { create: stepRows(input.steps) } },
      })
    }),
  )
}

/** 整体替换模板的步骤；已套用到工件上的步骤不受影响 */
export async function updateTemplate(id: string, input: TemplateInput) {
  return uniqueName(() =>
    prisma.$transaction(async (tx) => {
      const t = await tx.routeTemplate.findUnique({ where: { id }, select: { id: true } })
      if (!t) throw new FlowError('模板不存在或已删除')
      await assertSteps(tx, input.steps)
      await tx.routeTemplateStep.deleteMany({ where: { templateId: id } })
      return tx.routeTemplate.update({
        where: { id },
        data: { name: input.name.trim(), description: input.description?.trim() || null, steps: { create: stepRows(input.steps) } },
      })
    }),
  )
}

export async function deleteTemplate(id: string) {
  const r = await prisma.routeTemplate.deleteMany({ where: { id } }) // 步骤级联删除
  if (!r.count) throw new FlowError('模板不存在或已删除')
  return { ok: true }
}

/** 把工件当前的工序链存成模板（工序、方式、外协厂；不带负责人和日期） */
export async function saveTemplateFromPart(partId: string, input: { name: string; description?: string | null }, actorId: string) {
  const steps = await prisma.routeStep.findMany({ where: { partId }, orderBy: { seq: 'asc' }, select: { processId: true, mode: true, supplierId: true } })
  if (!steps.length) throw new FlowError('这个工件还没有工序链')
  return createTemplate({ ...input, steps }, actorId)
}

/** 给还没有工序的工件套用模板。负责人默认是操作人（与"添加工序"一致） */
export async function applyTemplate(partId: string, templateId: string, actorId: string, startDay?: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM part WHERE id = ${partId} FOR UPDATE`
    const part = await tx.part.findUnique({ where: { id: partId }, select: { id: true, _count: { select: { steps: true } } } })
    if (!part) throw new FlowError('工件不存在或已删除')
    if (part._count.steps) throw new FlowError('这个工件已经有工序链了，只能给还没有工序的工件套用模板')
    const template = await tx.routeTemplate.findUnique({ where: { id: templateId }, include: { steps: { orderBy: { seq: 'asc' } } } })
    if (!template) throw new FlowError('模板不存在或已删除')
    await assertSteps(tx, template.steps)
    const rows = routeFromTemplate(template.steps, startDay)
    await tx.routeStep.createMany({ data: rows.map((r) => ({ ...r, partId, ownerId: actorId })) })
    return { copied: rows.length, template: template.name }
  })
}
