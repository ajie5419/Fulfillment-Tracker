import { FLOW_EVENT_TEXT as SHARED_FLOW_EVENT_TEXT, FLOW_SOURCE_TEXT as SHARED_FLOW_SOURCE_TEXT } from '../../../shared/flow'
/**
 * 工件时间线和关联记录数（借鉴 ERPNext 单据的"活动"和顶部关联计数，10-26）。
 * 把散在各模块的记录按时间串起来：建档、设计任务、关键物料、工序流转、异常、留言。只读，不新增数据。
 */
import { prisma } from '../../utils/prisma'
import { CATEGORY_TEXT, STATUS_TEXT as ISSUE_STATUS_TEXT } from '../issues/constants'
import { countComments } from '../comments/comments'
import { RETURN_TYPES } from './flow'
import { loadNames } from './names'

const EVENT_TEXT = SHARED_FLOW_EVENT_TEXT
const SOURCE_TEXT = SHARED_FLOW_SOURCE_TEXT

export interface TimelineEntry {
  at: Date
  kind: 'part' | 'drawing' | 'purchase' | 'flow' | 'issue' | 'comment'
  /** 状态色：done 完成、late 延误 / 异常、risk 风险、primary 进行中、none 中性 */
  tone: 'done' | 'late' | 'risk' | 'primary' | 'none'
  title: string
  sub?: string
  link?: string
}

const enc = encodeURIComponent
const day = (d: Date) => d.toISOString().slice(0, 10)

export async function partTimeline(partId: string) {
  const part = await prisma.part.findUnique({
    where: { id: partId },
    include: {
      steps: { orderBy: { seq: 'asc' } },
      purchaseLines: { orderBy: { needDate: 'asc' } },
      drawingTasks: { include: { task: true } },
    },
  })
  if (!part) return null
  const stepIds = part.steps.map((s) => s.id)
  const [events, issues, comments] = await Promise.all([
    prisma.flowEvent.findMany({ where: { stepId: { in: stepIds } }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] }),
    prisma.issue.findMany({
      where: { OR: [{ refType: 'PART', refId: partId }, ...(stepIds.length ? [{ refType: 'STEP', refId: { in: stepIds } }] : [])] },
      include: { logs: { where: { toStatus: 'CLOSED' }, orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
    prisma.comment.findMany({ where: { refType: 'part', refId: partId } }),
  ])
  const stepOf = new Map(part.steps.map((s) => [s.id, s]))
  const names = await loadNames({
    process: part.steps.map((s) => s.processId),
    supplier: part.steps.map((s) => s.supplierId),
    user: [...events.map((e) => e.actorId), ...comments.map((c) => c.authorId), ...part.drawingTasks.map((d) => d.task.ownerId)],
  })
  const user = (id: string | null) => (id ? (names.user.get(id) ?? id) : null)
  const wo = part.workOrderNumber
  const out: TimelineEntry[] = []

  out.push({ at: part.createdAt, kind: 'part', tone: 'none', title: '建档', sub: part.fromTechBom ? '图纸发放附 BOM 自动建' : part.qmsBomId ? '从 QMS BOM 导入' : '手工新建' })
  for (const { task } of part.drawingTasks) {
    out.push({ at: task.createdAt, kind: 'drawing', tone: 'primary', title: `设计任务"${task.componentName}"`, sub: `计划 ${day(task.planDate)} 完成${task.ownerId ? `，${user(task.ownerId)}` : ''}`, link: `/drawings?wo=${enc(wo)}` })
    if (task.drawnDate) out.push({ at: task.drawnDate, kind: 'drawing', tone: 'done', title: `设计完成"${task.componentName}"`, link: `/drawings?wo=${enc(wo)}` })
  }
  for (const l of part.purchaseLines) {
    const what = `${l.materialName}${l.spec ? ` ${l.spec}` : ''}`
    out.push({ at: l.createdAt, kind: 'purchase', tone: 'primary', title: `关键物料"${what}"`, sub: `需求日 ${day(l.needDate)}${l.supplierName ? `，${l.supplierName}` : ''}`, link: `/purchases?wo=${enc(wo)}&id=${enc(l.id)}` })
    if (l.arrivedAt) out.push({ at: l.arrivedAt, kind: 'purchase', tone: 'done', title: `到货"${what}"`, sub: l.arrivedDate ? `到货日 ${day(l.arrivedDate)}` : undefined, link: `/purchases?wo=${enc(wo)}&id=${enc(l.id)}` })
  }
  for (const e of events) {
    const s = stepOf.get(e.stepId)!
    const process = names.process.get(s.processId) ?? s.processId
    const supplier = e.type === 'SEND' && s.supplierId ? ` → ${names.supplier.get(s.supplierId) ?? s.supplierId}` : ''
    const tone = e.type === 'SCRAP' ? 'late' : e.type === 'FINISH' || RETURN_TYPES.includes(e.type) ? 'done' : 'primary'
    const note = e.note ? `，${e.type === 'SEND' ? '随件发料' : '备注'}：${e.note}` : ''
    out.push({ at: e.occurredAt, kind: 'flow', tone, title: `${s.seq}. ${process} ${EVENT_TEXT[e.type]} ${e.qty} 件${supplier}`, sub: `${SOURCE_TEXT[e.source]}${user(e.actorId) ? `，${user(e.actorId)}` : ''}${note}` })
  }
  for (const i of issues) {
    const link = `/issues?id=${enc(i.id)}`
    out.push({ at: i.createdAt, kind: 'issue', tone: 'late', title: `异常 ${i.issueNo}（${CATEGORY_TEXT[i.category]}）`, sub: `${i.description.slice(0, 80)}　当前：${ISSUE_STATUS_TEXT[i.status]}`, link })
    const closed = i.logs[0]
    if (i.status === 'CLOSED' && closed) out.push({ at: closed.createdAt, kind: 'issue', tone: 'done', title: `异常 ${i.issueNo} 已关闭`, link })
  }
  for (const c of comments) out.push({ at: c.createdAt, kind: 'comment', tone: 'none', title: `${user(c.authorId)} 留言`, sub: c.body.length > 80 ? `${c.body.slice(0, 80)}…` : c.body })

  // 新的在上
  out.sort((a, b) => +b.at - +a.at)
  return { partId, partName: part.name, workOrderNumber: wo, entries: out }
}

/** 工件卡片顶部的关联记录数：设计任务（设计完成 / 全部，不含已取消）、关键物料（已到货 / 全部）、未关闭异常、留言 */
export async function partRelatedCounts(partIds: string[]) {
  if (!partIds.length) return new Map<string, RelatedCounts>()
  const [drawings, purchases, steps, comments] = await Promise.all([
    prisma.drawingTaskPart.findMany({ where: { partId: { in: partIds }, task: { status: { not: 'CANCELLED' } } }, select: { partId: true, task: { select: { drawnDate: true } } } }),
    prisma.purchaseLine.findMany({ where: { partId: { in: partIds } }, select: { partId: true, status: true } }),
    prisma.routeStep.findMany({ where: { partId: { in: partIds } }, select: { id: true, partId: true } }),
    countComments('part', partIds),
  ])
  const partOfStep = new Map(steps.map((s) => [s.id, s.partId]))
  const issues = await prisma.issue.findMany({
    where: { status: { not: 'CLOSED' }, OR: [{ refType: 'PART', refId: { in: partIds } }, ...(steps.length ? [{ refType: 'STEP', refId: { in: steps.map((s) => s.id) } }] : [])] },
    select: { refType: true, refId: true },
  })
  const out = new Map<string, RelatedCounts>(partIds.map((id) => [id, { drawings: 0, drawingsDone: 0, purchases: 0, purchasesArrived: 0, openIssues: 0, comments: comments.get(id) ?? 0 }]))
  for (const d of drawings) {
    const c = out.get(d.partId)!
    c.drawings++
    if (d.task.drawnDate) c.drawingsDone++
  }
  for (const p of purchases) {
    const c = out.get(p.partId!)!
    c.purchases++
    if (p.status === 'ARRIVED') c.purchasesArrived++
  }
  for (const i of issues) {
    const pid = i.refType === 'PART' ? i.refId : partOfStep.get(i.refId ?? '')
    if (pid && out.has(pid)) out.get(pid)!.openIssues++
  }
  return out
}

export interface RelatedCounts {
  drawings: number
  drawingsDone: number
  purchases: number
  purchasesArrived: number
  openIssues: number
  comments: number
}
