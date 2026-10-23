/**
 * 总计划模板（R14）：节点名称、顺序、责任部门、交期前天数；10-22 加阶段、工期、前置节点（模板里按顺序号）。设置页"总计划模板"维护（项目部负责人、管理员，接口层判断）。
 * 改模板不影响已经生成的总计划（生成时复制，复制即版本）。
 */
import { type BusinessDept, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { childrenOf, resolvePreds, topoOrder, waitsOn } from './constants'

export interface TemplateInput {
  name: string
  description?: string | null
  nodes: { name: string; dept: BusinessDept; daysBeforeDelivery: number; phase?: string | null; durationDays?: number | null; preds?: number[] | null; parent?: number | null }[]
}

const isUnique = (err: unknown) => (err as { code?: string })?.code === 'P2002'

function assertNodes(nodes: TemplateInput['nodes']) {
  if (!nodes.length) throw new FlowError('模板至少要有一个节点')
  const names = nodes.map((n) => n.name.trim())
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new FlowError(`节点名称重复：${dup}`)
  // 前置节点：顺序号要在模板范围内、不能是自己、不能成环（默认的"上一个"也算进去）
  for (const [i, n] of nodes.entries()) {
    for (const p of n.preds ?? []) {
      if (p < 1 || p > nodes.length) throw new FlowError(`第 ${i + 1} 个节点"${names[i]}"的前置节点 ${p} 不存在`)
      if (p === i + 1) throw new FlowError(`第 ${i + 1} 个节点"${names[i]}"的前置节点不能是自己`)
    }
  }
  // 上级节点：要排在前面、自己不能也是子节点（只有一层）；子节点的前置不能是自己的上级（上级要等子节点）
  for (const [i, n] of nodes.entries()) {
    if (n.parent == null) continue
    const label = `第 ${i + 1} 个节点"${names[i]}"`
    if (n.parent < 1 || n.parent >= i + 1) throw new FlowError(`${label}的上级节点要是排在它前面的节点`)
    if (nodes[n.parent - 1]!.parent != null) throw new FlowError(`${label}的上级"${names[n.parent - 1]}"本身是子节点：子节点下面不能再挂子节点`)
    if (n.preds?.includes(n.parent)) throw new FlowError(`${label}的前置节点不能是自己的上级（上级要等子节点做完）`)
  }
  const ids = nodes.map((_, i) => String(i + 1))
  const facts = nodes.map((n, i) => ({ id: ids[i]!, preds: n.preds == null ? null : n.preds.map(String), parent: n.parent == null ? null : String(n.parent) }))
  if (!topoOrder(ids, waitsOn(resolvePreds(facts), childrenOf(facts)))) throw new FlowError('前置节点成环了（A 等 B、B 又等 A），请检查')
}

export async function listTemplates() {
  const rows = await prisma.planTemplate.findMany({ orderBy: [{ createdAt: 'asc' }, { name: 'asc' }], include: { nodes: { orderBy: { seq: 'asc' } } } })
  const names = await loadNames({ user: rows.map((r) => r.createdBy) })
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    createdByName: t.createdBy ? (names.user.get(t.createdBy) ?? t.createdBy) : null,
    updatedAt: t.updatedAt,
    nodes: t.nodes.map((n) => ({
      seq: n.seq,
      name: n.name,
      dept: n.dept,
      deptText: BUSINESS_DEPT_NAME[n.dept],
      daysBeforeDelivery: n.daysBeforeDelivery,
      phase: n.phase,
      durationDays: n.durationDays,
      /** null = 默认上一个节点 */
      preds: Array.isArray(n.predSeqs) ? (n.predSeqs as unknown[]).map(Number) : null,
      /** 上级节点的顺序号；null = 一级节点 */
      parent: n.parentSeq,
    })),
  }))
}

const nodeRows = (nodes: TemplateInput['nodes']) =>
  nodes.map((n, i) => ({
    seq: i + 1,
    name: n.name.trim(),
    dept: n.dept,
    daysBeforeDelivery: n.daysBeforeDelivery,
    phase: n.phase?.trim() || null,
    durationDays: n.durationDays ?? null,
    predSeqs: n.preds == null ? Prisma.DbNull : [...new Set(n.preds)].sort((a, b) => a - b),
    parentSeq: n.parent ?? null,
    // 子节点的阶段跟上级
    ...(n.parent != null ? { phase: nodes[n.parent - 1]?.phase?.trim() || null } : {}),
  }))

export async function createTemplate(input: TemplateInput, actorId: string) {
  assertNodes(input.nodes)
  try {
    const t = await prisma.planTemplate.create({
      data: { name: input.name.trim(), description: input.description?.trim() || null, createdBy: actorId, nodes: { create: nodeRows(input.nodes) } },
    })
    return { id: t.id }
  } catch (err) {
    if (isUnique(err)) throw new FlowError('已有同名模板')
    throw err
  }
}

/** 整份替换节点 */
export async function updateTemplate(id: string, input: TemplateInput) {
  assertNodes(input.nodes)
  try {
    return await prisma.$transaction(async (tx) => {
      const t = await tx.planTemplate.findUnique({ where: { id }, select: { id: true } })
      if (!t) throw new FlowError('模板不存在')
      await tx.planTemplateNode.deleteMany({ where: { templateId: id } })
      await tx.planTemplate.update({
        where: { id },
        data: { name: input.name.trim(), description: input.description?.trim() || null, nodes: { create: nodeRows(input.nodes) } },
      })
      return { id }
    })
  } catch (err) {
    if (isUnique(err)) throw new FlowError('已有同名模板')
    throw err
  }
}

export async function deleteTemplate(id: string) {
  await prisma.planTemplate.deleteMany({ where: { id } }) // 节点级联删除；已生成的总计划不受影响
  return { ok: true }
}
