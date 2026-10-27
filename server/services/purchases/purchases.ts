/**
 * 关键物料采购跟踪（R10）：采购行增改删、到货确认（手工 / QMS 进货检验）、撤销到货、延误原因、"可以开工"待办。
 *
 * 只跟踪关键物料（长周期、进口、大件），采购员手工录入或 Excel 导入。不做审批。
 * 权限从简：能看到该工单的人都能录入、修改、确认到货（采购、仓库、使用部门都可能是确认人）；可见范围由接口层 canSee 判断。
 * 责任人：采购负责人（buyerId）；没指定时是采购部负责人。W6 未到货预警见 alerts/scan.ts。
 *
 * "可以开工"：工件挂的关键物料（未取消的）全部到货、且关联的设计任务（R11，未取消的）全部完成（设计完成、已发放、需要时客户已确认）
 * 的那一刻，给第一道工序负责人（没有时给生产部负责人）发待办；第一道已经开工/发出的不发。
 * 之后又挂上未到货的物料（新增、撤销到货、重新启用）或未完成的设计任务（新建、发放单作废、撤销设计完成）时，没处理的"可以开工"待办作废。
 * 待办在该工件任一道工序开工、发出或返厂时自动关闭（flow.ts）。
 *
 * 并发：采购事务都用 READ COMMITTED（锁到之后读到的是最新已提交数据，而不是事务开始时的快照），
 * 加锁顺序一律 先工件（按 ID 排序）→ 再采购行 / 设计任务（FOR UPDATE）。设计任务（drawings.ts）沿用同一事务和顺序。同一行的确认、撤销、修改串行执行；
 * 同一工件的几项同时到货时，"是否全部到货"的判断也串行，不会谁都不发"可以开工"。
 * 先锁工件是因为写采购行时外键检查会给工件行加共享锁，之后再要排他锁会和并发的另一项互相等（死锁）。
 */
import type { DelayReason, DrawingTaskStatus, FlowSource, Prisma, PurchaseLine, PurchaseStatus, RouteStep } from '@prisma/client'
import { firstStepTodoReady, prereqState } from '../flow/readiness'
import { resolveStepResponsible } from '../flow/responsible'
import { prisma } from '../../utils/prisma'
import { countComments, deleteCommentsOf } from '../comments/comments'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey, dateFieldDay, shanghaiDay } from '../alerts/rules'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { PRODUCTION_DEPT } from '../releases/constants'
import { planNodeLabels, planWarning, resolvePlanNode } from '../plan/links'
import {
  DELAY_REASON_TEXT,
  PAYMENT_STATUS_TEXT,
  PURCHASE_DEPT,
  READY_TO_START,
  delayStats,
  lineProgress,
  num,
  todayDate,
} from './constants'

type Tx = Prisma.TransactionClient

export interface LineInput {
  partId?: string | null
  materialName: string
  spec?: string | null
  quantity: number
  unit?: string | null
  supplierId?: string | null
  supplierName?: string | null
  needDate: Date
  promisedDate?: Date | null
  /** 所属总计划节点（R14） */
  planNodeId?: string | null
  buyerId?: string | null
  note?: string | null
}

export interface NewLineInput extends LineInput {
  workOrderNumber: string
  /** 录入时已经到了（导入历史数据、补录） */
  arrivedDate?: Date | null
}

export interface PatchLineInput extends Partial<LineInput> {
  delayReason?: DelayReason | null
  delayNote?: string | null
  /** 只能在 未到货 ⇄ 已取消 之间改；到货走 confirmArrival / undoArrival */
  status?: Extract<PurchaseStatus, 'OPEN' | 'CANCELLED'>
  /** 改已到货行的到货日（填错了） */
  arrivedDate?: Date
}

/** 采购相关的事务：READ COMMITTED，配合下面的加锁顺序 */
export function purchaseTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: 'ReadCommitted' })
}

/** 按 ID 顺序锁工件（FOR UPDATE） */
export async function lockParts(tx: Tx, ids: (string | null | undefined)[]) {
  for (const id of [...new Set(ids.filter((x): x is string => !!x))].sort()) {
    await tx.$queryRaw`SELECT id FROM part WHERE id = ${id} FOR UPDATE`
  }
}

/** 先锁所属工件（及 alsoParts，比如要移到的新工件），再锁住采购行并读最新数据 */
export async function lockLine(tx: Tx, id: string, alsoParts: (string | null | undefined)[] = []): Promise<PurchaseLine> {
  const cur = await tx.purchaseLine.findUnique({ where: { id }, select: { partId: true } })
  if (!cur) throw new FlowError('采购行不存在')
  await lockParts(tx, [cur.partId, ...alsoParts])
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_line WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('采购行不存在')
  const line = await tx.purchaseLine.findUniqueOrThrow({ where: { id } })
  // 极少见：锁之前刚被移到别的工件
  if (line.partId && line.partId !== cur.partId) await lockParts(tx, [line.partId])
  return line
}

const w6Key = (id: string) => alertKey('W6', 'purchase', id)

function assertNotFuture(d: Date, now: Date) {
  if (dateFieldDay(d) > shanghaiDay(now)) throw new FlowError('到货日期不能晚于今天')
}

// ───────────── 校验关联对象 ─────────────

/** 供应商：选了 QMS 供应商 → 存 ID 和名称；手填 → 只存名称 */
async function resolveSupplier(tx: Tx, supplierId: string | null | undefined, supplierName: string | null | undefined) {
  if (supplierId) {
    const s = await tx.qmsSupplier.findFirst({ where: { id: supplierId, isDeleted: false }, select: { id: true, name: true } })
    if (!s) throw new FlowError('供应商不存在或已停用')
    return { supplierId: s.id, supplierName: s.name }
  }
  return { supplierId: null, supplierName: supplierName?.trim() || null }
}

async function assertBuyer(tx: Tx, buyerId: string | null | undefined) {
  if (!buyerId) return
  const u = await tx.qmsUser.findFirst({ where: { id: buyerId, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
  if (!u) throw new FlowError('采购负责人不存在或已停用')
}

async function assertPart(tx: Tx, partId: string | null | undefined, workOrderNumber: string) {
  if (!partId) return
  const p = await tx.part.findUnique({ where: { id: partId }, select: { workOrderNumber: true } })
  if (!p || p.workOrderNumber !== workOrderNumber) throw new FlowError('工件不存在或不属于该工单')
}

// ───────────── 可以开工 ─────────────

/** 工件"可以开工"待办发给谁：第一道的负责人 → 班组长 → 生产部负责人。发待办和转交待办（steps.stepTodoHolders）共用 */
export async function readyOwners(tx: Tx, first: Pick<FirstStep, 'ownerId' | 'mode' | 'supplierId'>, workOrderNumber: string): Promise<string[]> {
  const owner = await resolveStepResponsible(tx, { ...first, workOrderNumber }, { lock: true })
  if (owner) return [owner]
  const heads = await tx.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: PRODUCTION_DEPT }, select: { userId: true } })
  return [...new Set(heads.map((h) => h.userId))]
}

type FirstStep = { status: RouteStep['status']; ownerId: string | null; mode: RouteStep['mode']; supplierId: string | null; holdReleaseId: string | null }

/**
 * 按工件当前的关键物料和设计任务情况处理"可以开工"待办：
 *   还有未到货的物料，或未完成的设计任务（未取消的），或第一道已不在待开工、正在"等变更" → 作废没处理的"可以开工"待办；
 *   都齐了（至少挂着一项物料或一个设计任务）、且 notify（本次操作让最后一项缺口没了：到货、取消、删除、移走、设计完成并发放）
 *   → 没有打开的待办时发一条。
 * 只在状态变化的那一刻发（notify），改备注之类的保存不会重复发。返回 sent / revoked / null。
 *
 * 锁顺序（全系统统一，见 server/utils/prisma.ts）：先锁工件（part FOR UPDATE，多个按 ID 排序，lockParts），再锁 / 改工序、采购行、待办，
 * 班组行最后（这里发待办算"谁负责"时对班组行加共享锁）。
 * 这里会锁工件：调用方如果要改工序（打 / 解"等变更"、建 / 调第一道），必须先 lockParts 再动工序，不能先改工序再进来，
 * 否则会和改工序（steps.updateStep 先锁工件再改工序）互相等锁。
 */
export async function refreshPartReady(tx: Tx, partId: string | null, notify: boolean): Promise<'sent' | 'revoked' | null> {
  if (!partId) return null
  // 串行化同一工件的判断（调用方通常已按顺序锁过，这里重入无害）；加锁读保证看到最新已提交数据
  const part = await tx.$queryRaw<{ id: string; workOrderNumber: string }[]>`SELECT id, workOrderNumber FROM part WHERE id = ${partId} FOR UPDATE`
  if (!part.length) return null
  const lines = await tx.$queryRaw<{ status: PurchaseStatus }[]>`SELECT status FROM purchase_line WHERE partId = ${partId} AND status <> 'CANCELLED' FOR SHARE`
  const drawings = await tx.$queryRaw<{ status: DrawingTaskStatus }[]>`
    SELECT t.status FROM drawing_task t JOIN drawing_task_part p ON p.taskId = t.id WHERE p.partId = ${partId} AND t.status <> 'CANCELLED' FOR SHARE`
  const now = new Date()
  const first = await tx.routeStep.findFirst({ where: { partId }, orderBy: { seq: 'asc' }, select: { status: true, ownerId: true, mode: true, supplierId: true, holdReleaseId: true } })
  // 与生产调度同一条规则（flow/readiness.ts firstStepTodoReady）：挂了东西、都齐了、第一道还在待开工且没在"等变更"
  const prereq = prereqState({ purchases: lines.map((l) => l.status), drawings: drawings.map((d) => d.status) })
  const ready = firstStepTodoReady(first && { status: first.status, held: !!first.holdReleaseId }, prereq)
  const where = { refType: 'part', refId: partId, action: READY_TO_START, status: 'OPEN' as const }
  if (!ready) {
    const r = await tx.todo.updateMany({ where, data: { status: 'CANCELLED', doneAt: now } })
    return r.count ? 'revoked' : null
  }
  if (!notify) return null
  const open = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM todo WHERE refType = 'part' AND refId = ${partId} AND action = ${READY_TO_START} AND status = 'OPEN' LIMIT 1 FOR SHARE`
  if (open.length) return null
  const owners = await readyOwners(tx, first!, part[0]!.workOrderNumber)
  if (!owners.length) return null
  await tx.todo.createMany({ data: owners.map((ownerId) => ({ ownerId, action: READY_TO_START, refType: 'part', refId: partId })) })
  return 'sent'
}

// ───────────── 新建 / 修改 / 删除 ─────────────

export async function createLine(input: NewLineInput, actorId: string) {
  const now = new Date()
  if (input.arrivedDate) assertNotFuture(input.arrivedDate, now)
  return purchaseTx(async (tx) => {
    await lockParts(tx, [input.partId])
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    await assertPart(tx, input.partId, wo.workOrderNumber)
    await assertBuyer(tx, input.buyerId)
    const supplier = await resolveSupplier(tx, input.supplierId, input.supplierName)
    const link = await resolvePlanNode(tx, wo.workOrderNumber, input.planNodeId, { creating: true })
    const line = await tx.purchaseLine.create({
      data: {
        workOrderNumber: wo.workOrderNumber,
        partId: input.partId || null,
        materialName: input.materialName.trim(),
        spec: input.spec?.trim() || null,
        quantity: input.quantity,
        unit: input.unit?.trim() || null,
        ...supplier,
        needDate: input.needDate,
        promisedDate: input.promisedDate ?? null,
        planNodeId: link.value ?? null,
        buyerId: input.buyerId || null,
        note: input.note?.trim() || null,
        createdBy: actorId,
        ...(input.arrivedDate ? { status: 'ARRIVED', arrivedDate: input.arrivedDate, arrivalSource: 'PC', arrivedBy: actorId, arrivedAt: now } : {}),
      },
    })
    // 补录已到货的不发"可以开工"（不是这一刻到的）；挂上未到货的，作废没处理的"可以开工"
    await refreshPartReady(tx, line.partId, false)
    return { ...line, planWarning: purchaseWarning(line, link.node) }
  })
}

/** 采购行的日期晚于节点计划日：有承诺到货日看承诺日，否则看需求日 */
const purchaseWarning = (l: { needDate: Date; promisedDate: Date | null }, node: Parameters<typeof planWarning>[2]) =>
  l.promisedDate ? planWarning('承诺到货日', l.promisedDate, node) : planWarning('需求日', l.needDate, node)

export async function updateLine(id: string, input: PatchLineInput) {
  const now = new Date()
  return purchaseTx(async (tx) => {
    const old = await lockLine(tx, id, [input.partId])
    const data: Prisma.PurchaseLineUncheckedUpdateInput = {}
    if (input.partId !== undefined) {
      await assertPart(tx, input.partId, old.workOrderNumber)
      data.partId = input.partId || null
    }
    if (input.materialName !== undefined) data.materialName = input.materialName.trim()
    if (input.spec !== undefined) data.spec = input.spec?.trim() || null
    if (input.quantity !== undefined) data.quantity = input.quantity
    if (input.unit !== undefined) data.unit = input.unit?.trim() || null
    if (input.supplierId !== undefined || input.supplierName !== undefined) {
      Object.assign(data, await resolveSupplier(tx, input.supplierId ?? null, input.supplierName ?? null))
    }
    if (input.needDate !== undefined) data.needDate = input.needDate
    if (input.promisedDate !== undefined) data.promisedDate = input.promisedDate
    const link = await resolvePlanNode(tx, old.workOrderNumber, input.planNodeId, { creating: false, oldNodeId: old.planNodeId })
    if (link.value !== undefined) data.planNodeId = link.value
    if (input.buyerId !== undefined) {
      await assertBuyer(tx, input.buyerId)
      data.buyerId = input.buyerId || null
    }
    if (input.note !== undefined) data.note = input.note?.trim() || null
    if (input.delayReason !== undefined) data.delayReason = input.delayReason
    if (input.delayNote !== undefined) data.delayNote = input.delayNote?.trim() || null
    if (input.arrivedDate !== undefined) {
      if (old.status !== 'ARRIVED') throw new FlowError('还没到货，请用"确认到货"')
      assertNotFuture(input.arrivedDate, now)
      data.arrivedDate = input.arrivedDate
    }
    if (input.status !== undefined && input.status !== old.status) {
      if (old.status === 'ARRIVED') throw new FlowError('已到货的不能直接改状态，请先撤销到货')
      data.status = input.status
    }
    const line = await tx.purchaseLine.update({ where: { id }, data })
    if (line.status !== 'OPEN') await clearAlertKeys(tx, [w6Key(id)])
    // 原工件：这一行原来未到货、现在不再算它的缺料（取消或移到别的工件）→ 可能刚好齐了
    const leftOld = old.partId && (line.partId !== old.partId || line.status === 'CANCELLED')
    if (leftOld) await refreshPartReady(tx, old.partId, old.status === 'OPEN')
    if (line.partId && (line.partId !== old.partId || line.status !== old.status)) await refreshPartReady(tx, line.partId, false)
    return { ...line, planWarning: line.status === 'OPEN' ? purchaseWarning(line, link.node) : null }
  })
}

/** 删除：关联了付款申请的不能删（改为"已取消"） */
export async function deleteLine(id: string) {
  return purchaseTx(async (tx) => {
    const line = await lockLine(tx, id)
    if (await tx.paymentLine.findFirst({ where: { purchaseLineId: id }, select: { paymentId: true } })) {
      throw new FlowError('已关联付款申请，不能删除；不再跟踪请改为"已取消"')
    }
    await deleteCommentsOf(tx, 'purchase', id) // 留言和它发出的提醒都没有外键，一起删
    await tx.purchaseLine.delete({ where: { id } })
    await clearAlertKeys(tx, [w6Key(id)])
    await refreshPartReady(tx, line.partId, line.status === 'OPEN')
    return { ok: true }
  })
}

// ───────────── 到货 ─────────────

export interface ArrivalInput {
  /** 默认今天（工厂时区） */
  arrivedDate?: Date | null
  delayReason?: DelayReason | null
  delayNote?: string | null
  source: FlowSource
  /** QMS 进货检验自动确认时的报检 ID */
  qmsInspectionId?: string | null
}

/** 在已锁住的采购行上记到货（手工确认、进货检验自动确认共用） */
export async function applyArrival(tx: Tx, line: PurchaseLine, input: ArrivalInput, actorId: string | null) {
  if (line.status === 'ARRIVED') throw new FlowError('这一项已经确认到货了，请刷新')
  if (line.status === 'CANCELLED') throw new FlowError('这一项已取消，不用确认到货')
  const now = new Date()
  const arrivedDate = input.arrivedDate ?? todayDate(now)
  assertNotFuture(arrivedDate, now)
  const late = lineProgress({ ...line, status: 'ARRIVED', arrivedDate }, now).late
  const updated = await tx.purchaseLine.update({
    where: { id: line.id },
    data: {
      status: 'ARRIVED',
      arrivedDate,
      arrivalSource: input.source,
      arrivedBy: actorId,
      arrivedAt: now,
      ...(input.qmsInspectionId ? { qmsInspectionId: input.qmsInspectionId } : {}),
      // 延误原因只对晚到的有意义；没晚的不改（可能是之前超期时填的，保留）
      ...(late && input.delayReason !== undefined ? { delayReason: input.delayReason } : {}),
      ...(late && input.delayNote !== undefined ? { delayNote: input.delayNote?.trim() || null } : {}),
    },
  })
  await clearAlertKeys(tx, [w6Key(line.id)])
  const ready = await refreshPartReady(tx, line.partId, true)
  return { line: updated, late, readySent: ready === 'sent' }
}

/** 手工确认到货（采购、仓库、使用部门；手机签收页或电脑） */
export async function confirmArrival(id: string, input: ArrivalInput, actorId: string) {
  return purchaseTx(async (tx) => {
    const line = await lockLine(tx, id)
    const r = await applyArrival(tx, line, { ...input, qmsInspectionId: null }, actorId)
    return { id, late: r.late, readySent: r.readySent }
  })
}

/** 撤销到货（确认错了）：回到未到货。自动到货用过的报检 ID 保留，这一行之后只能手工确认 */
export async function undoArrival(id: string) {
  return purchaseTx(async (tx) => {
    const line = await lockLine(tx, id)
    if (line.status !== 'ARRIVED') throw new FlowError('这一项还没到货')
    await tx.purchaseLine.update({ where: { id }, data: { status: 'OPEN', arrivedDate: null, arrivalSource: null, arrivedBy: null, arrivedAt: null } })
    await refreshPartReady(tx, line.partId, false)
    return { ok: true }
  })
}

// ───────────── 查询 ─────────────

/** blocked = 卡付款（未到货且有没付的卡交期付款申请，与统计 blockedByPayment 同一口径，前端改版第二轮统计卡用） */
export type LineView = 'open' | 'shortage' | 'late' | 'blocked' | 'arrived' | 'cancelled' | 'all'

export interface LineFilter {
  workOrderNumber?: string
  partId?: string
  view?: LineView
  /** 物料名称、规格、供应商关键字 */
  q?: string
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
  /** 付款金额可见（权限方案 R13：财务、采购部、领导、项目部负责人、管理员、该工单项目经理）；不给时都可见 */
  amountVisible?: AmountVisible
}

/** 按工单判断付款金额是否可见；不可见时接口里金额返回 null（不只是前端隐藏） */
export type AmountVisible = (workOrderNumber: string) => boolean

type LineWithPayments = PurchaseLine & {
  payments: { payment: { id: string; status: 'PENDING' | 'PAID' | 'ON_HOLD'; blocksDelivery: boolean; amount: Prisma.Decimal } }[]
}

async function describeLines(rows: LineWithPayments[], now: Date, amountVisible: AmountVisible = () => true) {
  const partIds = [...new Set(rows.map((r) => r.partId).filter((x): x is string => !!x))]
  const [parts, names, heads, planNodes] = await Promise.all([
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true, drawingNo: true } }) : [],
    loadNames({ user: rows.flatMap((r) => [r.buyerId, r.arrivedBy]) }),
    prisma.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: PURCHASE_DEPT }, select: { userId: true } }),
    planNodeLabels(rows.map((r) => r.planNodeId)),
  ])
  const headNames = (await loadNames({ user: heads.map((h) => h.userId) })).user
  const deptHead = heads.length ? `${PURCHASE_DEPT}（${heads.map((h) => headNames.get(h.userId) ?? h.userId).join('、')}）` : `${PURCHASE_DEPT}负责人（未设置）`
  const partOf = new Map(parts.map((p) => [p.id, p]))
  const alerts = rows.length
    ? await prisma.alert.findMany({ where: { activeKey: { in: rows.map((r) => w6Key(r.id)) } }, select: { activeKey: true, level: true } })
    : []
  const levelOf = new Map(alerts.map((a) => [a.activeKey!, a.level]))
  return rows.map(({ payments, ...r }) => {
    const p = lineProgress(r, now)
    const unpaid = payments.map((x) => x.payment).filter((x) => x.status !== 'PAID')
    const part = r.partId ? partOf.get(r.partId) : undefined
    return {
      ...r,
      quantity: num(r.quantity),
      progressText: p.text,
      late: p.late,
      shortage: p.shortage,
      lateDays: p.lateDays,
      delayReasonText: r.delayReason ? DELAY_REASON_TEXT[r.delayReason] : null,
      partName: part ? (part.drawingNo ? `${part.name}（${part.drawingNo}）` : part.name) : null,
      buyerName: r.buyerId ? (names.user.get(r.buyerId) ?? r.buyerId) : null,
      /** 没指定采购负责人时显示的默认责任人 */
      ownerText: r.buyerId ? (names.user.get(r.buyerId) ?? r.buyerId) : deptHead,
      arrivedByName: r.arrivedBy ? (names.user.get(r.arrivedBy) ?? r.arrivedBy) : r.arrivalSource === 'QMS_INSPECTION' ? 'QMS 进货检验' : null,
      payments: payments.map((x) => ({
        id: x.payment.id,
        status: x.payment.status,
        statusText: PAYMENT_STATUS_TEXT[x.payment.status],
        blocksDelivery: x.payment.blocksDelivery,
        amount: amountVisible(r.workOrderNumber) ? num(x.payment.amount) : null,
      })),
      /** 有没付的"卡交期"付款申请 */
      blockedByPayment: unpaid.some((x) => x.blocksDelivery),
      alertLevel: levelOf.get(w6Key(r.id)) ?? null,
      /** 所属总计划节点的序号、名称（列表"总计划节点"列）；没挂为 null */
      planNode: (r.planNodeId && planNodes.get(r.planNodeId)) || null,
    }
  })
}

const PAYMENTS_INCLUDE = { payments: { select: { payment: { select: { id: true, status: true, blocksDelivery: true, amount: true } } } } } as const

/** 每次最多返回的行数（按视图在数据库里先筛选、排序后再截断） */
const MAX_LIST_ROWS = 500

/** 延误（与 lineProgress 的 late 一致；日期都存为当天 UTC 零点，可以直接比较） */
function lateWhere(today: Date): Prisma.PurchaseLineWhereInput {
  const F = prisma.purchaseLine.fields
  return {
    OR: [
      { status: 'OPEN', OR: [{ needDate: { lt: today } }, { promisedDate: { lt: today } }] },
      { status: 'ARRIVED', OR: [{ arrivedDate: { gt: F.needDate } }, { arrivedDate: { gt: F.promisedDate } }] },
    ],
  }
}

/** 卡付款：未到货且有没付的"卡交期"付款申请 */
const BLOCKED_WHERE: Prisma.PurchaseLineWhereInput = { status: 'OPEN', payments: { some: { payment: { blocksDelivery: true, status: { not: 'PAID' } } } } }

function viewWhere(view: LineView, today: Date): Prisma.PurchaseLineWhereInput {
  switch (view) {
    case 'blocked':
      return BLOCKED_WHERE
    case 'open':
      return { status: 'OPEN' }
    case 'shortage':
      return { status: 'OPEN', needDate: { lte: today } }
    case 'late':
      return lateWhere(today)
    case 'arrived':
      return { status: 'ARRIVED' }
    case 'cancelled':
      return { status: 'CANCELLED' }
    default:
      return {}
  }
}

/** 统计：按可见范围、所选工单，不受视图和搜索影响；用 count / groupBy，不受列表截断影响 */
async function lineStats(scope: Prisma.PurchaseLineWhereInput[], today: Date) {
  const count = (w: Prisma.PurchaseLineWhereInput) => prisma.purchaseLine.count({ where: { AND: [...scope, w] } })
  const [open, shortage, noPromise, arrived, blockedByPayment, reasons] = await Promise.all([
    count({ status: 'OPEN' }),
    count({ status: 'OPEN', needDate: { lte: today } }),
    count({ status: 'OPEN', promisedDate: null }),
    count({ status: 'ARRIVED' }),
    count(BLOCKED_WHERE),
    prisma.purchaseLine.groupBy({ by: ['delayReason'], where: { AND: [...scope, lateWhere(today)] }, _count: { _all: true } }),
  ])
  const delay = delayStats([])
  for (const r of reasons) {
    delay.late += r._count._all
    if (r.delayReason) delay.byReason[r.delayReason] += r._count._all
    else delay.unfilled += r._count._all
  }
  delay.payment = delay.byReason.PAYMENT
  delay.management = delay.byReason.SUPPLIER + delay.byReason.DEMAND_CHANGE + delay.byReason.OTHER
  return { open, shortage, noPromise, arrived, blockedByPayment, delay }
}

/**
 * 采购行列表 + 统计。视图、关键字在数据库里筛选，再按顺序截断到 500 行（total 是筛选后的总数）。
 * 排序：未到货的按需求日从近到远在前；已到货的按到货日从近到远；已取消的最后。
 */
export async function listLines(filter: LineFilter, now = new Date()) {
  const today = todayDate(now)
  const scope: Prisma.PurchaseLineWhereInput[] = []
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.partId) scope.push({ partId: filter.partId })
  const view = filter.view ?? 'open'
  const q = filter.q?.trim()
  // MySQL 默认排序规则不区分大小写
  const search: Prisma.PurchaseLineWhereInput[] = q
    ? [{ OR: [{ materialName: { contains: q } }, { spec: { contains: q } }, { supplierName: { contains: q } }, { workOrderNumber: { contains: q } }] }]
    : []
  const where: Prisma.PurchaseLineWhereInput = { AND: [...scope, viewWhere(view, today), ...search] }
  // 状态枚举顺序就是 未到货 → 已到货 → 已取消
  const orderBy: Prisma.PurchaseLineOrderByWithRelationInput[] =
    view === 'arrived' ? [{ arrivedDate: 'desc' }, { id: 'asc' }] : [{ status: 'asc' }, { needDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  const [found, total, stats] = await Promise.all([
    prisma.purchaseLine.findMany({ where, include: PAYMENTS_INCLUDE, orderBy, take: MAX_LIST_ROWS }),
    prisma.purchaseLine.count({ where }),
    lineStats(scope, today),
  ])
  const [described, comments] = await Promise.all([describeLines(found, now, filter.amountVisible), countComments('purchase', found.map((l) => l.id))])
  // 留言条数（列表上"留言 N"，10-26）
  const rows = described.map((r) => ({ ...r, commentCount: comments.get(r.id) ?? 0 }))
  const rank = { OPEN: 0, ARRIVED: 1, CANCELLED: 2 } as const
  rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'ARRIVED' ? +(b.arrivedDate ?? 0) - +(a.arrivedDate ?? 0) : +a.needDate - +b.needDate))
  return { rows, total, stats }
}

/** 单行详情（手机到货确认页、电脑详情） */
export async function getLine(id: string, now = new Date(), amountVisible?: AmountVisible) {
  const line = await prisma.purchaseLine.findUnique({ where: { id }, include: PAYMENTS_INCLUDE })
  if (!line) throw new FlowError('采购行不存在')
  const [row] = await describeLines([line], now, amountVisible)
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber: line.workOrderNumber }, select: { projectName: true, customerName: true } })
  return { ...row!, projectName: wo?.projectName ?? null, customerName: wo?.customerName ?? null }
}

/** 采购行所属工单（接口层做可见性检查用）；不存在时 null */
export async function workOrderOfLine(id: string) {
  return (await prisma.purchaseLine.findUnique({ where: { id }, select: { workOrderNumber: true } }))?.workOrderNumber ?? null
}

/** 我的待办里的"可以开工"：附上工件和第一道工序，页面按工序方式给"登记发出"或"开工"按钮 */
export async function describeReadyTodos(partIds: string[]) {
  if (!partIds.length) return new Map<string, Awaited<ReturnType<typeof readyPart>>>()
  const parts = await prisma.part.findMany({
    where: { id: { in: partIds } },
    include: {
      steps: { orderBy: { seq: 'asc' }, take: 1 },
      purchaseLines: { where: { status: 'ARRIVED' }, select: { id: true } },
      drawingTasks: { where: { task: { status: 'DONE' } }, select: { taskId: true } },
    },
  })
  const firsts = parts.map((p) => p.steps[0]).filter((s): s is NonNullable<typeof s> => !!s)
  const names = await loadNames({ process: firsts.map((s) => s.processId), supplier: firsts.map((s) => s.supplierId) })
  return new Map(parts.map((p) => [p.id, readyPart(p, names)]))
}

function readyPart(
  p: Prisma.PartGetPayload<{ include: { steps: true; purchaseLines: { select: { id: true } }; drawingTasks: { select: { taskId: true } } } }>,
  names: Awaited<ReturnType<typeof loadNames>>,
) {
  const s = p.steps[0]
  return {
    partId: p.id,
    partName: p.name,
    workOrderNumber: p.workOrderNumber,
    arrived: p.purchaseLines.length,
    /** 已完成（已发放）的设计任务数（R11） */
    drawings: p.drawingTasks.length,
    step: s
      ? {
          id: s.id,
          seq: s.seq,
          status: s.status,
          mode: s.mode,
          processName: names.process.get(s.processId) ?? s.processId,
          supplierId: s.supplierId,
          supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? null) : null,
          partId: p.id,
          partName: p.name,
          workOrderNumber: p.workOrderNumber,
          held: !!s.holdReleaseId,
          /** 第一道的应开工日（YYYY-MM-DD），待办截止日用 */
          planStartDay: s.planStartDate ? s.planStartDate.toISOString().slice(0, 10) : null,
        }
      : null,
  }
}
