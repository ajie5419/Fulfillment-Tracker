/**
 * 齐套（R12）：装配节点的增删改、节点清单（工件 + 关键物料）、齐套率、缺件清单（卡在哪一步）。
 *
 * 装配节点挂在工单下（总装 / 部装），带需求日；清单里选这个节点需要的工件（M1）和关键物料（R10，只限同一工单）。
 * 同一工件 / 物料可以挂在多个节点上，不互斥。齐套率现算、不落库（规则见 constants.ts）。
 *
 * 权限：能看到该工单的人都能看（接口层 canSee）；新建、修改、删除限 生产经理（生产部负责人）、该工单的项目经理、管理员。
 * 节点负责人本人不受工单可见范围限制（手机"我负责的节点"）。
 *
 * 性能：齐套率、缺件原因按一批节点一次查完（工件 + 工序、物料、设计任务、挂在工件上的物料、发放单号、名称），不随节点数增加查询次数；
 * 列表先在数据库里按"未齐套"、负责人、可见范围筛选并排序，再截断。
 */
import type { AssemblyNode, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { DAY_MS, type RuleThreshold, alertKey, dateFieldDay, dayDiff, shanghaiDay } from '../alerts/rules'
import { OPEN_DRAWING_STATUSES } from '../drawings/constants'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { PURCHASE_STATUS_TEXT, num, todayDate } from '../purchases/constants'
import { planNodeLabels, planWarning, resolvePlanNode } from '../plan/links'
import {
  KITTING_DEPT,
  type KitCount,
  countKit,
  isIncomplete,
  isPartReady,
  isPurchaseCounted,
  isPurchaseReady,
  kitPercent,
  materialShortage,
  partBlocker,
} from './constants'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
export type NodeWithLinks = AssemblyNode & { parts: { partId: string }[]; purchases: { purchaseLineId: string }[] }

export const NODE_LINKS = { parts: { select: { partId: true } }, purchases: { select: { purchaseLineId: true } } } as const

export const w8Key = (id: string) => alertKey('W8', 'node', id)

export interface Actor {
  userId: string
  isAdmin: boolean
}

export interface NodeInput {
  name: string
  needDate: Date
  /** 所属总计划节点（R14） */
  planNodeId?: string | null
  /** 空 = 生产经理（生产部负责人） */
  ownerId?: string | null
  note?: string | null
  sortOrder?: number | null
  partIds?: string[]
  purchaseIds?: string[]
}

export interface NewNodeInput extends NodeInput {
  workOrderNumber: string
}

const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** 每次最多返回的节点数（在数据库里先筛选、排序后再截断） */
const MAX_LIST_ROWS = 300

// ───────────── 数据库筛选口径（与 constants.ts isIncomplete 一致）─────────────

/**
 * 未齐套：清单里有没完成的工件，或有未到货（未取消）的物料。
 * Match the in-memory readiness check, including legacy DONE parts with unfinished steps.
 */
export function incompleteWhere(): Prisma.AssemblyNodeWhereInput {
  return {
    OR: [
      { parts: { some: { part: { OR: [{ status: { not: 'DONE' } }, { steps: { some: { status: { not: 'DONE' } } } }] } } } },
      { purchases: { some: { purchase: { status: 'OPEN' } } } },
    ],
  }
}

/** 进入 W8 预警窗口：需求日 ≤ 今天 + 黄阈值天数（含已过） */
export function dueWindowWhere(now: Date, t: RuleThreshold): Prisma.AssemblyNodeWhereInput {
  return { needDate: { lte: new Date(+todayDate(now) + Math.max(t.yellowDays, t.redDays) * DAY_MS) } }
}

// ───────────── 权限 ─────────────

export interface EditorContext {
  isAdmin: boolean
  /** 生产经理（生产部负责人）：所有工单都能编辑 */
  isProductionHead: boolean
  /** 我是项目经理的工单 */
  pmOf: Set<string>
}

export async function editorContext(actor: Actor, db: Db = prisma): Promise<EditorContext> {
  // 生产经理身份单独查：管理员同时是生产经理时，"我负责的"还要带上没指定负责人的节点
  const [head, managed] = await Promise.all([
    db.notifyRole.findFirst({ where: { role: 'DEPT_HEAD', department: KITTING_DEPT, userId: actor.userId }, select: { id: true } }),
    // 管理员什么都能改，不用再查自己管哪些工单
    actor.isAdmin ? [] : db.workOrderExt.findMany({ where: { projectManagerId: actor.userId }, select: { workOrderNumber: true } }),
  ])
  return { isAdmin: actor.isAdmin, isProductionHead: !!head, pmOf: new Set(managed.map((m) => m.workOrderNumber)) }
}

/** 新建、修改、删除装配节点：生产经理、该工单项目经理、管理员 */
export const canEditWith = (ctx: EditorContext, workOrderNumber: string) => ctx.isAdmin || ctx.isProductionHead || ctx.pmOf.has(workOrderNumber)

async function assertCanEdit(db: Db, actor: Actor, workOrderNumber: string) {
  if (!canEditWith(await editorContext(actor, db), workOrderNumber)) throw new FlowForbidden('只有生产经理、该工单的项目经理或管理员可以新建、修改装配节点')
}

// ───────────── 校验 ─────────────

async function assertOwner(db: Db, ownerId: string | null | undefined) {
  if (!ownerId) return
  const u = await db.qmsUser.findFirst({ where: { id: ownerId, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
  if (!u) throw new FlowError('节点负责人不存在或已停用')
}

async function assertItems(db: Db, workOrderNumber: string, partIds: string[], purchaseIds: string[]) {
  const [parts, lines] = await Promise.all([
    partIds.length ? db.part.findMany({ where: { id: { in: partIds } }, select: { workOrderNumber: true } }) : [],
    purchaseIds.length ? db.purchaseLine.findMany({ where: { id: { in: purchaseIds } }, select: { workOrderNumber: true } }) : [],
  ])
  if (parts.length !== partIds.length || parts.some((p) => p.workOrderNumber !== workOrderNumber)) throw new FlowError('所选工件不存在或不属于该工单')
  if (lines.length !== purchaseIds.length || lines.some((l) => l.workOrderNumber !== workOrderNumber)) throw new FlowError('所选关键物料不存在或不属于该工单')
}

/** 只读这个节点清单里各项的状态，算应有项 / 已就绪（事务里用，判断要不要立即消除 W8） */
async function kitCountOf(db: Db, nodeId: string): Promise<KitCount> {
  const [parts, lines] = await Promise.all([
    db.assemblyNodePart.findMany({ where: { nodeId }, select: { part: { select: { status: true, steps: { select: { status: true } } } } } }),
    db.assemblyNodePurchase.findMany({ where: { nodeId }, select: { purchase: { select: { status: true } } } }),
  ])
  return countKit(
    parts.map((p) => p.part),
    lines.map((l) => l.purchase),
  )
}

async function lockNode(tx: Tx, id: string): Promise<NodeWithLinks> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM assembly_node WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('装配节点不存在或已删除')
  return tx.assemblyNode.findUniqueOrThrow({ where: { id }, include: NODE_LINKS })
}

// ───────────── 新建 / 修改 / 删除 ─────────────

export async function createNode(input: NewNodeInput, actor: Actor) {
  const partIds = uniq(input.partIds ?? [])
  const purchaseIds = uniq(input.purchaseIds ?? [])
  return prisma.$transaction(async (tx) => {
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    await assertCanEdit(tx, actor, wo.workOrderNumber)
    await assertOwner(tx, input.ownerId)
    await assertItems(tx, wo.workOrderNumber, partIds, purchaseIds)
    const link = await resolvePlanNode(tx, wo.workOrderNumber, input.planNodeId, { creating: true })
    // 不填排序时排在该工单最后
    const sortOrder =
      input.sortOrder ?? ((await tx.assemblyNode.aggregate({ where: { workOrderNumber: wo.workOrderNumber }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1
    const node = await tx.assemblyNode.create({
      data: {
        workOrderNumber: wo.workOrderNumber,
        name: input.name.trim(),
        needDate: input.needDate,
        planNodeId: link.value ?? null,
        ownerId: input.ownerId || null,
        note: input.note?.trim() || null,
        sortOrder,
        createdBy: actor.userId,
        parts: { create: partIds.map((partId) => ({ partId })) },
        purchases: { create: purchaseIds.map((purchaseLineId) => ({ purchaseLineId })) },
      },
    })
    return { ...node, planWarning: planWarning('需求日', node.needDate, link.node) }
  })
}

export async function updateNode(id: string, input: Partial<NodeInput>, actor: Actor) {
  const partIds = input.partIds ? uniq(input.partIds) : undefined
  const purchaseIds = input.purchaseIds ? uniq(input.purchaseIds) : undefined
  return prisma.$transaction(async (tx) => {
    const old = await lockNode(tx, id)
    await assertCanEdit(tx, actor, old.workOrderNumber)
    const data: Prisma.AssemblyNodeUncheckedUpdateInput = {}
    if (input.name !== undefined) data.name = input.name.trim()
    if (input.needDate !== undefined) data.needDate = input.needDate
    const link = await resolvePlanNode(tx, old.workOrderNumber, input.planNodeId, { creating: false, oldNodeId: old.planNodeId })
    if (link.value !== undefined) data.planNodeId = link.value
    if (input.ownerId !== undefined) {
      await assertOwner(tx, input.ownerId)
      data.ownerId = input.ownerId || null
    }
    if (input.note !== undefined) data.note = input.note?.trim() || null
    if (input.sortOrder != null) data.sortOrder = input.sortOrder
    await assertItems(tx, old.workOrderNumber, partIds ?? [], purchaseIds ?? [])
    if (partIds) {
      await tx.assemblyNodePart.deleteMany({ where: { nodeId: id, partId: { notIn: partIds } } })
      await tx.assemblyNodePart.createMany({ data: partIds.map((partId) => ({ nodeId: id, partId })), skipDuplicates: true })
    }
    if (purchaseIds) {
      await tx.assemblyNodePurchase.deleteMany({ where: { nodeId: id, purchaseLineId: { notIn: purchaseIds } } })
      await tx.assemblyNodePurchase.createMany({ data: purchaseIds.map((purchaseLineId) => ({ nodeId: id, purchaseLineId })), skipDuplicates: true })
    }
    if (Object.keys(data).length) await tx.assemblyNode.update({ where: { id }, data })
    // W8：齐了（或清单清空了）立即消除；需求日真的改了（按自然日比）也先清掉，下一轮扫描按新日期重算。
    // 编辑弹窗每次都带上需求日，原样保存不能清预警，否则下一轮会重新首发、重复通知
    const kit = await kitCountOf(tx, id)
    const dateChanged = input.needDate !== undefined && dateFieldDay(input.needDate) !== dateFieldDay(old.needDate)
    if (!isIncomplete(kit) || dateChanged) await clearAlertKeys(tx, [w8Key(id)])
    return { id, ...kit, percent: kitPercent(kit), planWarning: planWarning('需求日', input.needDate ?? old.needDate, link.node) }
  })
}

export async function deleteNode(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const node = await lockNode(tx, id)
    await assertCanEdit(tx, actor, node.workOrderNumber)
    await tx.assemblyNode.delete({ where: { id } }) // 清单随节点级联删除
    await clearAlertKeys(tx, [w8Key(id)])
    return { ok: true }
  })
}

// ───────────── 齐套率与缺件（一批节点一次算完）─────────────

export interface ShortageRow {
  kind: 'part' | 'purchase'
  id: string
  name: string
  /** 工件：当前工序名；物料：采购状态文字 */
  stage: string | null
  /** 卡在哪一步（主要原因） */
  reason: string
  reasonCode: string
  detail: string | null
  /** 物料：需求日、承诺到货日（'YYYY-MM-DD'） */
  needDate?: string
  promisedDate?: string | null
  /** 物料：已过承诺日或需求日 */
  overdue?: boolean
  /** 物料：承诺日晚于节点需求日（赶不上） */
  lateForNode?: boolean
}

export interface NodeKit extends KitCount {
  percent: number | null
  incomplete: boolean
  shortages: ShortageRow[]
  /** 已就绪的项（名称） */
  readyItems: string[]
  /** 已取消、不计入的物料（名称） */
  excluded: string[]
}

/** 只要状态（扫描、计数用）：两次查询 */
export async function loadKitCounts(nodes: NodeWithLinks[], db: Tx = prisma): Promise<Map<string, KitCount>> {
  const partIds = uniq(nodes.flatMap((n) => n.parts.map((p) => p.partId)))
  const lineIds = uniq(nodes.flatMap((n) => n.purchases.map((p) => p.purchaseLineId)))
  const [parts, lines] = await Promise.all([
    partIds.length ? db.part.findMany({ where: { id: { in: partIds } }, select: { id: true, status: true, statusSince: true, steps: { select: { status: true } } } }) : [],
    lineIds.length ? db.purchaseLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, status: true, arrivedDate: true } }) : [],
  ])
  const partOf = new Map(parts.map((p) => [p.id, p]))
  const lineOf = new Map(lines.map((l) => [l.id, l]))
  return new Map(
    nodes.map((n) => [
      n.id,
      countKit(
        n.parts.map((p) => partOf.get(p.partId)).filter((x) => !!x),
        n.purchases.map((p) => lineOf.get(p.purchaseLineId)).filter((x) => !!x),
      ),
    ]),
  )
}

/** 齐套率 + 缺件清单（含卡在哪一步）。查询次数固定，不随节点数、工件数增加 */
export async function loadKits(nodes: NodeWithLinks[], now: Date): Promise<Map<string, NodeKit>> {
  const partIds = uniq(nodes.flatMap((n) => n.parts.map((p) => p.partId)))
  const lineIds = uniq(nodes.flatMap((n) => n.purchases.map((p) => p.purchaseLineId)))
  const [parts, lines] = await Promise.all([
    partIds.length
      ? prisma.part.findMany({
          where: { id: { in: partIds } },
          select: { id: true, name: true, drawingNo: true, status: true, steps: { select: { seq: true, status: true, processId: true, holdReleaseId: true } } },
        })
      : [],
    lineIds.length
      ? prisma.purchaseLine.findMany({
          where: { id: { in: lineIds } },
          select: { id: true, materialName: true, spec: true, quantity: true, unit: true, status: true, needDate: true, promisedDate: true, supplierName: true },
        })
      : [],
  ])
  // 只有没完成的工件要找原因
  const waiting = parts.filter((p) => !isPartReady(p)).map((p) => p.id)
  const holdIds = uniq(parts.flatMap((p) => p.steps.map((s) => s.holdReleaseId)).filter((x): x is string => !!x))
  const [drawings, materials, releases, names] = await Promise.all([
    waiting.length
      ? prisma.drawingTaskPart.findMany({ where: { partId: { in: waiting }, task: { status: { in: OPEN_DRAWING_STATUSES } } }, select: { partId: true, task: { select: { componentName: true } } } })
      : [],
    waiting.length ? prisma.purchaseLine.findMany({ where: { partId: { in: waiting }, status: 'OPEN' }, select: { partId: true, materialName: true } }) : [],
    holdIds.length ? prisma.release.findMany({ where: { id: { in: holdIds } }, select: { id: true, releaseNo: true } }) : [],
    loadNames({ process: parts.flatMap((p) => p.steps.map((s) => s.processId)) }),
  ])
  const releaseNo = new Map(releases.map((r) => [r.id, r.releaseNo]))
  const partOf = new Map(parts.map((p) => [p.id, p]))
  const lineOf = new Map(lines.map((l) => [l.id, l]))
  const group = (rows: { partId: string | null; name: string }[]) => {
    const m = new Map<string, string[]>()
    for (const r of rows) if (r.partId) m.set(r.partId, [...(m.get(r.partId) ?? []), r.name])
    return m
  }
  const drawingsOf = group(drawings.map((d) => ({ partId: d.partId, name: d.task.componentName })))
  const materialsOf = group(materials.map((m) => ({ partId: m.partId, name: m.materialName })))
  const blockerOf = new Map(
    waiting.map((id) => {
      const p = partOf.get(id)!
      return [
        id,
        partBlocker({
          steps: p.steps.map((s) => ({
            seq: s.seq,
            status: s.status,
            processName: names.process.get(s.processId) ?? s.processId,
            held: !!s.holdReleaseId,
            holdReleaseNo: s.holdReleaseId ? (releaseNo.get(s.holdReleaseId) ?? null) : null,
          })),
          openDrawings: drawingsOf.get(id) ?? [],
          openMaterials: materialsOf.get(id) ?? [],
        }),
      ]
    }),
  )
  const partName = (p: { name: string; drawingNo: string | null }) => (p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name)
  const lineName = (l: { materialName: string; spec: string | null }) => (l.spec ? `${l.materialName}（${l.spec}）` : l.materialName)

  const out = new Map<string, NodeKit>()
  for (const n of nodes) {
    const ps = n.parts.map((x) => partOf.get(x.partId)).filter((x) => !!x)
    const ls = n.purchases.map((x) => lineOf.get(x.purchaseLineId)).filter((x) => !!x)
    const kit = countKit(ps, ls)
    const shortages: ShortageRow[] = []
    const readyItems: string[] = []
    for (const p of ps) {
      if (isPartReady(p)) {
        readyItems.push(partName(p))
        continue
      }
      const b = blockerOf.get(p.id)!
      shortages.push({ kind: 'part', id: p.id, name: partName(p), stage: b.stage, reason: b.text, reasonCode: b.code, detail: b.detail })
    }
    const counted = ls.filter(isPurchaseCounted)
    // 物料按承诺到货日（没有的按需求日）从近到远
    const open = counted.filter((l) => !isPurchaseReady(l)).sort((a, b) => +(a.promisedDate ?? a.needDate) - +(b.promisedDate ?? b.needDate))
    for (const l of counted) if (isPurchaseReady(l)) readyItems.push(lineName(l))
    for (const l of open) {
      const m = materialShortage(l, n.needDate, now)
      const qty = num(l.quantity)
      shortages.push({
        kind: 'purchase',
        id: l.id,
        name: lineName(l),
        stage: m.text,
        reason: PURCHASE_STATUS_TEXT[l.status],
        reasonCode: 'NOT_ARRIVED',
        detail: [qty != null ? `${qty}${l.unit ?? ''}` : '', l.supplierName ?? ''].filter(Boolean).join(' · ') || null,
        needDate: dateFieldDay(l.needDate),
        promisedDate: l.promisedDate ? dateFieldDay(l.promisedDate) : null,
        overdue: m.overdue,
        lateForNode: m.lateForNode,
      })
    }
    out.set(n.id, {
      ...kit,
      percent: kitPercent(kit),
      incomplete: isIncomplete(kit),
      shortages,
      readyItems,
      excluded: ls.filter((l) => !isPurchaseCounted(l)).map(lineName),
    })
  }
  return out
}

// ───────────── 查询 ─────────────

async function productionHeadText() {
  const heads = await prisma.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: KITTING_DEPT }, select: { userId: true } })
  const names = (await loadNames({ user: heads.map((h) => h.userId) })).user
  return heads.length ? `生产经理（${heads.map((h) => names.get(h.userId) ?? h.userId).join('、')}）` : '生产经理（未设置）'
}

async function describeNodes(rows: NodeWithLinks[], now: Date, ctx: EditorContext | null) {
  const ids = rows.map((r) => r.id)
  const [kits, names, alerts, headText, planNodes] = await Promise.all([
    loadKits(rows, now),
    loadNames({ user: rows.map((r) => r.ownerId) }),
    ids.length ? prisma.alert.findMany({ where: { activeKey: { in: ids.map(w8Key) } }, select: { activeKey: true, level: true } }) : [],
    productionHeadText(),
    planNodeLabels(rows.map((r) => r.planNodeId)),
  ])
  const levelOf = new Map(alerts.map((a) => [a.activeKey!, a.level]))
  const today = shanghaiDay(now)
  return rows.map(({ parts, purchases, ...n }) => {
    const kit = kits.get(n.id)!
    const ownerName = n.ownerId ? (names.user.get(n.ownerId) ?? n.ownerId) : null
    return {
      ...n,
      partIds: parts.map((p) => p.partId),
      purchaseIds: purchases.map((p) => p.purchaseLineId),
      ownerName,
      /** 没指定负责人时显示默认负责人 */
      ownerText: ownerName ?? headText,
      daysLeft: dayDiff(today, dateFieldDay(n.needDate)),
      ...kit,
      // 预警下一轮扫描才消除：已经齐了就不再显示
      alertLevel: kit.incomplete ? (levelOf.get(w8Key(n.id)) ?? null) : null,
      canEdit: !!ctx && canEditWith(ctx, n.workOrderNumber),
      /** 所属总计划节点的序号、名称（列表"总计划节点"列）；没挂为 null */
      planNode: (n.planNodeId && planNodes.get(n.planNodeId)) || null,
    }
  })
}

export type NodeRow = Awaited<ReturnType<typeof describeNodes>>[number]

export interface NodeFilter {
  workOrderNumber?: string
  /** 只看未齐套 */
  incompleteOnly?: boolean
  /** 只看需求日临近（W8 预警窗口内，含已过）仍未齐套的（与统计 dueSoon 同一口径） */
  dueSoonOnly?: boolean
  /** 我负责的：负责人是我，或没指定负责人而我是生产经理（不受工单可见范围限制） */
  mine?: { userId: string; isProductionHead: boolean }
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
}

/**
 * 装配节点列表 + 统计。筛选（工单、未齐套、我负责的、可见范围）都在数据库里做，排序后再截断（total 是筛选后的总数）。
 * 排序：指定了工单时按节点顺序（排序号 → 需求日）；跨工单时按需求日从近到远。
 */
export async function listNodes(filter: NodeFilter, actor: Actor, t: RuleThreshold, now = new Date()) {
  const scope: Prisma.AssemblyNodeWhereInput[] = []
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.mine) scope.push({ OR: [{ ownerId: filter.mine.userId }, ...(filter.mine.isProductionHead ? [{ ownerId: null }] : [])] })
  const where: Prisma.AssemblyNodeWhereInput = {
    AND: [...scope, ...(filter.incompleteOnly || filter.dueSoonOnly ? [incompleteWhere()] : []), ...(filter.dueSoonOnly ? [dueWindowWhere(now, t)] : [])],
  }
  const orderBy: Prisma.AssemblyNodeOrderByWithRelationInput[] = filter.workOrderNumber
    ? [{ sortOrder: 'asc' }, { needDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
    : [{ needDate: 'asc' }, { workOrderNumber: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
  const count = (w: Prisma.AssemblyNodeWhereInput[]) => prisma.assemblyNode.count({ where: { AND: [...scope, ...w] } })
  const [found, total, all, incomplete, dueSoon, ctx] = await Promise.all([
    prisma.assemblyNode.findMany({ where, include: NODE_LINKS, orderBy, take: MAX_LIST_ROWS }),
    prisma.assemblyNode.count({ where }),
    count([]),
    count([incompleteWhere()]),
    count([incompleteWhere(), dueWindowWhere(now, t)]),
    editorContext(actor),
  ])
  return {
    rows: await describeNodes(found, now, ctx),
    total,
    stats: { all, incomplete, dueSoon, windowDays: Math.max(t.yellowDays, t.redDays), yellowDays: t.yellowDays, redDays: t.redDays },
    /** 能在所选工单上新建节点（没选工单时：至少能在某个工单上建） */
    canCreate: filter.workOrderNumber ? canEditWith(ctx, filter.workOrderNumber) : ctx.isAdmin || ctx.isProductionHead || ctx.pmOf.size > 0,
  }
}

/** 单个节点（编辑、从提醒跳转） */
export async function getNode(id: string, actor: Actor, now = new Date()) {
  const node = await prisma.assemblyNode.findUnique({ where: { id }, include: NODE_LINKS })
  if (!node) throw new FlowError('装配节点不存在或已删除')
  const [row] = await describeNodes([node], now, await editorContext(actor))
  return row!
}

/** 编辑弹窗的选项：该工单的工件（带是否已完成）和关键物料（带状态；已取消的标出来） */
export async function nodeOptions(workOrderNumber: string) {
  const [parts, lines] = await Promise.all([
    prisma.part.findMany({ where: { workOrderNumber }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, drawingNo: true, status: true, steps: { select: { status: true } } } }),
    prisma.purchaseLine.findMany({
      where: { workOrderNumber },
      orderBy: [{ needDate: 'asc' }, { createdAt: 'asc' }],
      take: 1000,
      select: { id: true, materialName: true, spec: true, status: true, needDate: true },
    }),
  ])
  return {
    parts: parts.map((p) => ({ id: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name, ready: isPartReady(p) })),
    purchases: lines.map((l) => ({
      id: l.id,
      label: `${l.spec ? `${l.materialName}（${l.spec}）` : l.materialName} · 需求 ${dateFieldDay(l.needDate)}`,
      status: l.status,
      statusText: PURCHASE_STATUS_TEXT[l.status],
    })),
  }
}
