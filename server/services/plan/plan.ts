/**
 * 项目部总计划（R14，总计划设计.md）：每个工单一份，按模板倒推生成 → 项目经理调整 → 发布（锁基线、各部门确认）→
 * 部门记录挂节点 → 预计完成日沿前置节点顺延（10-22 起支持多条线并行，默认前置 = 上一个节点）→ 预计交期 / 拖期天数、余量、W9 预警。
 *
 *   发布前（草稿）：随便改日期、增删节点，不记调整记录；
 *   发布后：当时的计划日记为基线（不再变）；给每个节点的责任部门负责人发"确认总计划节点"待办（可确认、可退回写原因，退回提醒项目经理）；
 *     发布立即生效，不等各部门全部确认；改计划日、发布后加 / 删节点必须写原因，写进调整记录；
 *     改了日期或责任部门的节点重新请部门确认（原来的确认作废）。
 *   节点完成：挂靠任务全部完成时自动完成（现算，见 constants.ts）；也可以由责任部门的人、项目经理手动标记。
 *
 * 权限在接口层（utils/auth.ts + auth/permissions.ts）判断；这里只做业务规则。
 * 并发：同一工单的总计划操作先锁 work_order_plan 行（没有时建一行）再改节点，串行执行。
 */
import type { BusinessDept, PlanNode, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { type RoleContext, canOperate, isDeptHead } from '../auth/permissions'
import { DRAWING_STATUS_TEXT, drawingLink } from '../drawings/constants'
import { FlowError } from '../flow/errors'
import { cancelTaskTodos } from './tasks'
import { MODE_TEXT, loadNames } from '../flow/names'
import { kittingLink } from '../kitting/constants'
import { NODE_LINKS, type NodeWithLinks, loadKitCounts } from '../kitting/kitting'
import { PURCHASE_STATUS_TEXT, purchaseLink, todayDate } from '../purchases/constants'
import {
  CONFIRM_PLAN_NODE,
  CONFIRM_TEXT,
  type NodeFacts,
  PLAN_REF,
  type PlanForecast,
  TASK_KIND_TEXT,
  type TaskFacts,
  type TaskKind,
  addDays,
  isCritical,
  assemblyFacts,
  drawingFacts,
  forecastPlan,
  planLink,
  planTaskFacts,
  purchaseFacts,
  resolvePreds,
  stepFacts,
  topoOrder,
  w9ConfirmKey,
  w9Key,
  w9PlanKey,
  w9SplitKey,
} from './constants'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

const day = (d: Date) => dateFieldDay(d)
const parse = (d: string) => new Date(`${d}T00:00:00.000Z`)
const STEP_STATUS_TEXT = { PENDING: '待开工', OUT: '在外加工', IN_PROGRESS: '加工中', DONE: '已完成', BLOCKED: '有异常' } as const

// ───────────── 读：节点 + 挂靠任务 → 预计 ─────────────

interface TaskRow {
  kind: TaskKind
  id: string
  nodeId: string
  name: string
  /** 部门日期叫什么（计划完成日 / 承诺到货日 / 需求日 / 承诺返回日 / 要求完成日） */
  dateLabel: string
  statusText: string
  link: string
  facts: TaskFacts
  /** 其他任务：负责人、备注（其余类型没有） */
  owner?: { id: string; name: string }
  note?: string | null
}

export interface PlanData {
  workOrderNumber: string
  status: 'DRAFT' | 'PUBLISHED' | null
  /** 发布时间（W9 未分解提醒从这里起计时） */
  publishedAt: Date | null
  deliveryDay: string | null
  nodes: PlanNode[]
  tasks: TaskRow[]
  forecast: PlanForecast
}

/**
 * 读一批工单的总计划并算预计（总计划页、看板、领导总览、每日汇总、W9 扫描共用，口径一致）。
 * publishedOnly：只要已发布的（预警、统计只看已发布的）。每类挂靠记录一次查询，不随节点数增加查询次数。
 */
export async function loadPlans(filter: { workOrderNumbers?: string[]; publishedOnly?: boolean }, now = new Date()): Promise<Map<string, PlanData>> {
  const plans = await prisma.workOrderPlan.findMany({
    where: { ...(filter.workOrderNumbers ? { workOrderNumber: { in: filter.workOrderNumbers } } : {}), ...(filter.publishedOnly ? { status: 'PUBLISHED' } : {}) },
  })
  const wos = filter.publishedOnly ? plans.map((p) => p.workOrderNumber) : (filter.workOrderNumbers ?? plans.map((p) => p.workOrderNumber))
  if (!wos.length) return new Map()
  const nodes = await prisma.planNode.findMany({ where: { workOrderNumber: { in: wos } }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const nodeIds = nodes.map((n) => n.id)
  const linked = { planNodeId: { in: nodeIds } }
  const [workOrders, drawings, purchases, steps, assemblies, others, deps] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, deliveryDate: true } }),
    nodeIds.length ? prisma.drawingTask.findMany({ where: linked, orderBy: { planDate: 'asc' } }) : [],
    nodeIds.length ? prisma.purchaseLine.findMany({ where: linked, orderBy: { needDate: 'asc' } }) : [],
    nodeIds.length ? prisma.routeStep.findMany({ where: linked, include: { part: { select: { name: true } } }, orderBy: [{ partId: 'asc' }, { seq: 'asc' }] }) : [],
    nodeIds.length ? prisma.assemblyNode.findMany({ where: linked, include: NODE_LINKS, orderBy: { needDate: 'asc' } }) : [],
    nodeIds.length ? prisma.planTask.findMany({ where: linked, orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }] }) : [],
    nodeIds.length ? prisma.planNodeDep.findMany({ where: { nodeId: { in: nodeIds } } }) : [],
  ])
  const today = shanghaiDay(now)
  const [kits, names] = await Promise.all([
    loadKitCounts(assemblies as NodeWithLinks[]),
    loadNames({ process: steps.map((s) => s.processId), user: others.map((t) => t.ownerId) }),
  ])
  const tasks: TaskRow[] = [
    ...drawings.map((d) => ({
      kind: 'drawing' as const,
      id: d.id,
      nodeId: d.planNodeId!,
      name: d.componentName,
      dateLabel: d.drawnDate && d.needsCustomerConfirm && !d.customerConfirmedDate && d.customerPlanDate ? '客户确认计划日' : '计划完成日',
      statusText: DRAWING_STATUS_TEXT[d.status],
      link: drawingLink(d.id),
      facts: drawingFacts(d),
    })),
    ...purchases.map((l) => ({
      kind: 'purchase' as const,
      id: l.id,
      nodeId: l.planNodeId!,
      name: l.spec ? `${l.materialName}（${l.spec}）` : l.materialName,
      dateLabel: l.promisedDate ? '承诺到货日' : '需求日',
      statusText: PURCHASE_STATUS_TEXT[l.status],
      link: purchaseLink(l.id),
      facts: purchaseFacts(l),
    })),
    ...steps.map((s) => ({
      kind: 'step' as const,
      id: s.id,
      nodeId: s.planNodeId!,
      name: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}（${MODE_TEXT[s.mode]}）`,
      dateLabel: s.mode === 'EXTERNAL_OUTSOURCE' && s.promisedReturnDate ? '承诺返回日' : '要求完成日',
      statusText: STEP_STATUS_TEXT[s.status],
      link: `/parts?wo=${encodeURIComponent('')}`, // 下面按节点所属工单补全
      facts: stepFacts(s, shanghaiDay),
    })),
    ...assemblies.map((a) => {
      const kit = kits.get(a.id) ?? { total: 0, ready: 0 }
      return {
        kind: 'assembly' as const,
        id: a.id,
        nodeId: a.planNodeId!,
        name: a.name,
        dateLabel: '需求日',
        statusText: kit.total ? `齐套 ${kit.ready}/${kit.total}` : '清单为空',
        link: kittingLink(a.id),
        facts: assemblyFacts(a, kit, today),
      }
    }),
    ...others.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      nodeId: t.planNodeId,
      name: t.name,
      dateLabel: '计划完成日',
      statusText: t.doneDate ? '已完成' : `负责人 ${names.user.get(t.ownerId) ?? t.ownerId}`,
      link: planLink(t.workOrderNumber, t.planNodeId),
      facts: planTaskFacts(t),
      owner: { id: t.ownerId, name: names.user.get(t.ownerId) ?? t.ownerId },
      note: t.note,
    })),
  ]
  const woOfNode = new Map(nodes.map((n) => [n.id, n.workOrderNumber]))
  const predsOf = new Map<string, string[]>()
  for (const d of deps) predsOf.set(d.nodeId, [...(predsOf.get(d.nodeId) ?? []), d.predId])
  for (const t of tasks) if (t.kind === 'step') t.link = `/parts?wo=${encodeURIComponent(woOfNode.get(t.nodeId) ?? '')}`
  const delivery = new Map(workOrders.map((w) => [w.workOrderNumber, day(w.deliveryDate)]))
  const statusOf = new Map(plans.map((p) => [p.workOrderNumber, p.status]))
  const publishedAtOf = new Map(plans.map((p) => [p.workOrderNumber, p.publishedAt]))
  const out = new Map<string, PlanData>()
  for (const wo of wos) {
    const mine = nodes.filter((n) => n.workOrderNumber === wo)
    const myTasks = tasks.filter((t) => woOfNode.get(t.nodeId) === wo)
    const facts: NodeFacts[] = mine.map((n) => ({
      id: n.id,
      planDay: day(n.planDate),
      startDay: n.startDate ? day(n.startDate) : null,
      preds: n.customDeps ? (predsOf.get(n.id) ?? []) : null,
      manualDoneDay: n.manualDoneAt && n.actualDate ? day(n.actualDate) : null,
      tasks: myTasks.filter((t) => t.nodeId === n.id).map((t) => t.facts),
    }))
    const deliveryDay = delivery.get(wo) ?? null
    out.set(wo, {
      workOrderNumber: wo,
      status: statusOf.get(wo) ?? null,
      publishedAt: publishedAtOf.get(wo) ?? null,
      deliveryDay,
      nodes: mine,
      tasks: myTasks,
      forecast: forecastPlan(facts, deliveryDay ?? facts.at(-1)?.planDay ?? today, today),
    })
  }
  return out
}

// ───────────── 总计划页 ─────────────

async function myConfirmTodos(userId: string, nodeIds: string[]) {
  if (!nodeIds.length) return new Set<string>()
  const todos = await prisma.todo.findMany({ where: { ownerId: userId, refType: PLAN_REF, refId: { in: nodeIds }, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, select: { refId: true } })
  return new Set(todos.map((t) => t.refId))
}

/** 没挂节点的部门记录条数（老数据；已取消的设计任务、采购行不算） */
async function unlinkedCounts(wo: string) {
  const [drawing, purchase, step, assembly] = await Promise.all([
    prisma.drawingTask.count({ where: { workOrderNumber: wo, planNodeId: null, status: { not: 'CANCELLED' } } }),
    prisma.purchaseLine.count({ where: { workOrderNumber: wo, planNodeId: null, status: { not: 'CANCELLED' } } }),
    prisma.routeStep.count({ where: { part: { workOrderNumber: wo }, planNodeId: null } }),
    prisma.assemblyNode.count({ where: { workOrderNumber: wo, planNodeId: null } }),
  ])
  return { drawing, purchase, step, assembly, total: drawing + purchase + step + assembly }
}

/** 总计划页：工单信息、发布状态、节点（基线 / 当前 / 预计 / 实际、确认、挂靠任务）、预计交期、未挂节点数、调整记录、当前用户能做什么 */
export async function getPlan(workOrderNumber: string, ctx: RoleContext, now = new Date()) {
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber } })
  if (!wo) throw new FlowError('工单不存在')
  const [data, plan, ext, logs, unlinked] = await Promise.all([
    loadPlans({ workOrderNumbers: [workOrderNumber] }, now).then((m) => m.get(workOrderNumber)!),
    prisma.workOrderPlan.findUnique({ where: { workOrderNumber } }),
    prisma.workOrderExt.findUnique({ where: { workOrderNumber } }),
    prisma.planChangeLog.findMany({ where: { workOrderNumber }, orderBy: { createdAt: 'desc' }, take: 200 }),
    unlinkedCounts(workOrderNumber),
  ])
  const nodeIds = data.nodes.map((n) => n.id)
  const [names, mine, alerts] = await Promise.all([
    loadNames({ user: [ext?.projectManagerId ?? null, plan?.publishedBy ?? null, ...data.nodes.flatMap((n) => [n.confirmedBy, n.manualDoneBy]), ...logs.map((l) => l.actorId)] }),
    myConfirmTodos(ctx.userId, nodeIds),
    prisma.alert.findMany({
      where: { activeKey: { in: [w9PlanKey(workOrderNumber), ...nodeIds.map(w9Key), ...nodeIds.map(w9ConfirmKey), ...nodeIds.map(w9SplitKey)] } },
      select: { activeKey: true, level: true },
    }),
  ])
  const user = (id: string | null | undefined) => (id ? (names.user.get(id) ?? id) : null)
  const levelOf = new Map(alerts.map((a) => [a.activeKey!, a.level]))
  const planAlert = alerts.find((a) => a.activeKey === w9PlanKey(workOrderNumber))
  const published = plan?.status === 'PUBLISHED'
  const est = new Map(data.forecast.nodes.map((n) => [n.id, n]))
  const seqName = new Map(data.nodes.map((n) => [n.id, { seq: n.seq, name: n.name }]))
  /** 用了前置节点或开始日（多条线并行）：页面才显示余量 / 关键节点；一条主线时每个节点都"关键"，不显示 */
  const network = data.nodes.some((n) => n.customDeps || n.startDate)
  const hasSucc = new Set(data.forecast.nodes.flatMap((e) => e.preds))
  return {
    workOrder: {
      workOrderNumber,
      projectName: wo.projectName,
      customerName: wo.customerName,
      deliveryDate: data.deliveryDay,
      projectManagerId: ext?.projectManagerId ?? null,
      projectManagerName: user(ext?.projectManagerId),
    },
    plan: plan ? { status: plan.status, templateName: plan.templateName, publishedAt: plan.publishedAt, publishedByName: user(plan.publishedBy) } : null,
    expectedDelivery: data.forecast.expectedDelivery,
    deliveryDelayDays: data.forecast.deliveryDelayDays,
    delayedNodes: data.forecast.delayedNodes,
    sourceNodes: data.forecast.sourceNodes,
    /** W9 工单级（预计交期晚于合同交期）的活动预警级别 */
    planAlertLevel: planAlert?.level ?? null,
    unlinked,
    network,
    /** 没有后续节点接着的节点（最后一个除外）：它们晚了不影响预计交期，多半是漏连了前置关系 */
    dangling: network ? data.nodes.filter((n, i) => i < data.nodes.length - 1 && !hasSucc.has(n.id)).map((n) => ({ id: n.id, seq: n.seq, name: n.name })) : [],
    /** 阶段下拉（已用过的阶段名，按出现顺序） */
    phases: [...new Set(data.nodes.map((n) => n.phase).filter((x): x is string => !!x))],
    canEdit: canOperate(ctx, 'plan', { workOrderNumber }),
    /** 节点"分解"菜单里能新建哪几类部门记录（只决定显示，后端各自再校验） */
    canCreate: {
      drawing: canOperate(ctx, 'drawing', { workOrderNumber }),
      purchase: canOperate(ctx, 'purchase', { workOrderNumber }),
      route: canOperate(ctx, 'route', { workOrderNumber }),
      kitting: ctx.isAdmin || isDeptHead(ctx, 'PRODUCTION') || ctx.pmOf.has(workOrderNumber),
    },
    nodes: data.nodes.map((n) => {
      const e = est.get(n.id)!
      const tasks = data.tasks.filter((t) => t.nodeId === n.id)
      const canSplit = canOperate(ctx, 'planTask', { workOrderNumber, dept: n.dept })
      return {
        id: n.id,
        seq: n.seq,
        name: n.name,
        dept: n.dept,
        deptText: BUSINESS_DEPT_NAME[n.dept],
        note: n.note,
        phase: n.phase,
        startDate: n.startDate ? day(n.startDate) : null,
        planDate: day(n.planDate),
        /** 前置节点：customDeps = false 时是默认的"上一个节点" */
        customDeps: n.customDeps,
        preds: e.preds.map((id) => ({ id, ...seqName.get(id)! })),
        /** 被哪个前置节点推后（driver = prev 时） */
        pushedBy: e.pushedBy ? (seqName.get(e.pushedBy) ?? null) : null,
        slackDays: network ? e.slackDays : null,
        critical: network && isCritical(e),
        baselineDate: n.baselineDate ? day(n.baselineDate) : null,
        expectedDate: e.expectedDay,
        actualDate: e.actualDay,
        done: e.done,
        doneBy: e.doneBy,
        manualDoneByName: user(n.manualDoneBy),
        delayDays: e.delayDays,
        driver: e.driver,
        selfExpectedDate: e.selfExpectedDay,
        selfDelayDays: e.selfDelayDays,
        source: e.source,
        upstream: e.upstream,
        confirmStatus: n.confirmStatus,
        confirmText: n.confirmStatus ? CONFIRM_TEXT[n.confirmStatus] : null,
        confirmedByName: user(n.confirmedBy),
        confirmedAt: n.confirmedAt,
        rejectReason: n.rejectReason,
        taskCount: e.taskCount,
        doneCount: e.doneCount,
        overdueCount: e.overdueCount,
        lateCount: e.lateCount,
        alertLevel: levelOf.get(w9Key(n.id)) ?? null,
        confirmAlertLevel: levelOf.get(w9ConfirmKey(n.id)) ?? null,
        tasks: tasks.map((t) => {
          const te = e.tasks.find((x) => x.kind === t.kind && x.id === t.id)!
          return {
            kind: t.kind,
            kindText: TASK_KIND_TEXT[t.kind],
            id: t.id,
            name: t.name,
            dateLabel: t.dateLabel,
            planDate: t.facts.planDay,
            expectedDate: te.expectedDay,
            doneDate: t.facts.done ? t.facts.doneDay : null,
            done: t.facts.done,
            excluded: t.facts.excluded,
            overdue: te.overdue,
            lateForNode: te.lateForNode,
            statusText: t.statusText,
            link: t.link,
            ownerId: t.owner?.id ?? null,
            ownerName: t.owner?.name ?? null,
            note: t.note ?? null,
            /** 其他任务：能改 / 删（节点责任部门的人、项目经理、项目部、管理员）；能标完成 / 撤销（再加任务负责人） */
            canEdit: t.kind === 'task' && canSplit,
            canDone: t.kind === 'task' && (canSplit || t.owner?.id === ctx.userId),
          }
        }),
        /** 未分解：节点下还没有任何部门任务（不算已取消的） */
        unsplit: e.taskCount === 0,
        splitAlertLevel: levelOf.get(w9SplitKey(n.id)) ?? null,
        /** 能在这个节点下分解（加其他任务；4 类记录另看 canCreate） */
        canSplit,
        canConfirm: published && n.confirmStatus !== null && (canOperate(ctx, 'planConfirm', { dept: n.dept }) || mine.has(n.id)),
        canComplete: canOperate(ctx, 'planNodeDone', { workOrderNumber, dept: n.dept }),
      }
    }),
    changeLogs: logs.map((l) => ({
      id: l.id,
      nodeId: l.nodeId,
      nodeName: l.nodeName,
      kind: l.kind,
      oldDate: l.oldDate ? day(l.oldDate) : null,
      newDate: l.newDate ? day(l.newDate) : null,
      reason: l.reason,
      actorName: user(l.actorId),
      createdAt: l.createdAt,
    })),
  }
}

/** 部门记录弹窗的"所属总计划节点"下拉：只列同一工单的节点；published 时新建必选 */
export async function planOptions(workOrderNumber: string) {
  const [plan, nodes] = await Promise.all([
    prisma.workOrderPlan.findUnique({ where: { workOrderNumber }, select: { status: true } }),
    prisma.planNode.findMany({ where: { workOrderNumber }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }], select: { id: true, seq: true, name: true, dept: true, planDate: true } }),
  ])
  return {
    published: plan?.status === 'PUBLISHED',
    nodes: nodes.map((n) => ({ id: n.id, seq: n.seq, name: n.name, dept: n.dept, deptText: BUSINESS_DEPT_NAME[n.dept], planDate: day(n.planDate) })),
  }
}

// ───────────── 写 ─────────────

/** 锁住工单的总计划行（没有时建一行草稿），同一工单的总计划操作串行 */
async function lockPlan(tx: Tx, workOrderNumber: string, actorId: string | null) {
  await tx.workOrderPlan.upsert({ where: { workOrderNumber }, update: {}, create: { workOrderNumber, createdBy: actorId } })
  await tx.$queryRaw`SELECT workOrderNumber FROM work_order_plan WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
  return tx.workOrderPlan.findUniqueOrThrow({ where: { workOrderNumber } })
}

async function assertWorkOrder(db: Db, workOrderNumber: string) {
  const wo = await db.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true, deliveryDate: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
  return wo
}

/** 节点责任部门的负责人（项目部另含"项目部负责人"） */
export async function deptHeads(db: Db, dept: BusinessDept): Promise<string[]> {
  const roles = await db.notifyRole.findMany({
    where: { OR: [{ role: 'DEPT_HEAD', department: BUSINESS_DEPT_NAME[dept] }, ...(dept === 'PROJECT' ? [{ role: 'PROJECT_DEPT_HEAD' as const }] : [])] },
    select: { userId: true },
  })
  return [...new Set(roles.map((r) => r.userId))]
}

/** 请部门确认：状态改为待确认，作废没处理的旧确认待办，给责任部门负责人发新待办；超时未确认的旧预警清掉（从新待办重新计时） */
async function requestConfirm(tx: Tx, node: Pick<PlanNode, 'id' | 'dept'>): Promise<number> {
  await tx.planNode.update({ where: { id: node.id }, data: { confirmStatus: 'PENDING', confirmedBy: null, confirmedAt: null, rejectReason: null } })
  await tx.todo.updateMany({ where: { refType: PLAN_REF, refId: node.id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
  await clearAlertKeys(tx, [w9ConfirmKey(node.id)])
  const owners = await deptHeads(tx, node.dept)
  if (owners.length) await tx.todo.createMany({ data: owners.map((ownerId) => ({ ownerId, action: CONFIRM_PLAN_NODE, refType: PLAN_REF, refId: node.id })) })
  return owners.length
}

/** 日期、顺序、前置关系改了以后，全工单节点的延误预警按新计划重算（下一轮扫描），先清掉旧的（有前置关系后受影响的不一定在后面） */
async function clearDelayAlerts(tx: Tx, workOrderNumber: string) {
  const all = await tx.planNode.findMany({ where: { workOrderNumber }, select: { id: true } })
  await clearAlertKeys(tx, all.map((n) => w9Key(n.id)))
}

/** 写前置节点：null = 恢复默认（上一个节点），数组 = 自定（可以为空 = 没有前置）。只能选同一工单的其他节点 */
async function saveDeps(tx: Tx, workOrderNumber: string, nodeId: string, preds: string[] | null) {
  await tx.planNodeDep.deleteMany({ where: { nodeId } })
  if (preds == null) {
    await tx.planNode.update({ where: { id: nodeId }, data: { customDeps: false } })
    return
  }
  const ids = [...new Set(preds)]
  if (ids.includes(nodeId)) throw new FlowError('前置节点不能选自己')
  const ok = await tx.planNode.count({ where: { id: { in: ids }, workOrderNumber } })
  if (ok !== ids.length) throw new FlowError('前置节点要是同一个工单总计划里的节点，请刷新后重选')
  await tx.planNode.update({ where: { id: nodeId }, data: { customDeps: true } })
  if (ids.length) await tx.planNodeDep.createMany({ data: ids.map((predId) => ({ nodeId, predId })) })
}

/** 改完以后整份校验：前置关系不能成环（默认的"上一个节点"也算，调顺序也可能成环），在同一事务里失败就整体回滚 */
async function assertNoCycle(tx: Tx, workOrderNumber: string) {
  const nodes = await tx.planNode.findMany({ where: { workOrderNumber }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true, customDeps: true } })
  const deps = await tx.planNodeDep.findMany({ where: { nodeId: { in: nodes.map((n) => n.id) } } })
  const preds = resolvePreds(nodes.map((n) => ({ id: n.id, preds: n.customDeps ? deps.filter((d) => d.nodeId === n.id).map((d) => d.predId) : null })))
  if (topoOrder(nodes.map((n) => n.id), preds)) return
  throw new FlowError('前置节点成环了（A 等 B、B 又等 A）：请检查前置节点，或者没自定前置的节点默认等"上一个节点"，调整顺序后可能成环')
}

const startCheck = (start: Date | null | undefined, plan: Date) => {
  if (start && day(start) > day(plan)) throw new FlowError(`计划开始日 ${day(start)} 不能晚于计划完成日 ${day(plan)}`)
}

const needReason = (published: boolean, reason: string | null | undefined, what: string) => {
  if (published && !reason?.trim()) throw new FlowError(`总计划已发布，${what}要写调整原因`)
}

/**
 * 按模板生成：模板里的"交期前多少天"按 QMS 交期倒推出各节点计划日；有工期的算出计划开始日，有前置的连上前置节点。
 * 只能在草稿（或还没有总计划）时生成；已有的草稿节点整份替换（挂在它们上面的部门记录变成未挂）。
 */
export async function generateFromTemplate(workOrderNumber: string, templateId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const wo = await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    if (plan.status === 'PUBLISHED') throw new FlowError('总计划已发布，不能再按模板重新生成（可以逐个调整节点）')
    const tpl = await tx.planTemplate.findUnique({ where: { id: templateId }, include: { nodes: { orderBy: { seq: 'asc' } } } })
    if (!tpl) throw new FlowError('模板不存在')
    if (!tpl.nodes.length) throw new FlowError('模板里还没有节点')
    const delivery = day(wo.deliveryDate)
    // 草稿节点下已分解的其他任务随节点一起删，待办作废
    await cancelTaskTodos(tx, (await tx.planTask.findMany({ where: { workOrderNumber }, select: { id: true } })).map((t) => t.id))
    const replaced = await tx.planNode.deleteMany({ where: { workOrderNumber } })
    // 逐个建（要拿到 ID 连前置节点）；模板有工期的算出计划开始日，有前置顺序号的转成节点 ID
    const idOfSeq = new Map<number, string>()
    for (const [i, n] of tpl.nodes.entries()) {
      const plan = addDays(delivery, -n.daysBeforeDelivery)
      const node = await tx.planNode.create({
        data: {
          workOrderNumber,
          seq: i + 1,
          name: n.name,
          dept: n.dept,
          phase: n.phase,
          planDate: parse(plan),
          startDate: n.durationDays && n.durationDays > 0 ? parse(addDays(plan, -(n.durationDays - 1))) : null,
          customDeps: Array.isArray(n.predSeqs),
        },
      })
      idOfSeq.set(n.seq, node.id)
    }
    const deps = tpl.nodes.flatMap((n) =>
      (Array.isArray(n.predSeqs) ? (n.predSeqs as unknown[]) : [])
        .map((seq) => idOfSeq.get(Number(seq)))
        .filter((predId): predId is string => !!predId && predId !== idOfSeq.get(n.seq))
        .map((predId) => ({ nodeId: idOfSeq.get(n.seq)!, predId })),
    )
    if (deps.length) await tx.planNodeDep.createMany({ data: deps, skipDuplicates: true })
    await assertNoCycle(tx, workOrderNumber)
    await tx.workOrderPlan.update({ where: { workOrderNumber }, data: { templateName: tpl.name } })
    return { created: tpl.nodes.length, replaced: replaced.count }
  })
}

export interface NodeInput {
  name: string
  dept: BusinessDept
  planDate: Date
  /** 阶段（分组显示） */
  phase?: string | null
  /** 计划开始日（可选，不能晚于计划日） */
  startDate?: Date | null
  /** 前置节点 ID：null = 默认上一个节点；[] = 没有前置 */
  preds?: string[] | null
  /** 顺序号：小的在前；不填 = 排最后 */
  seq?: number | null
  note?: string | null
  /** 已发布时必填：调整原因 */
  reason?: string | null
}

/** 加节点。发布后加的节点没有基线，要写原因（记调整记录），并请责任部门确认 */
export async function createNode(workOrderNumber: string, input: NodeInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    const published = plan.status === 'PUBLISHED'
    needReason(published, input.reason, '加节点')
    const seq = input.seq ?? ((await tx.planNode.aggregate({ where: { workOrderNumber }, _max: { seq: true } }))._max.seq ?? 0) + 1
    startCheck(input.startDate, input.planDate)
    const node = await tx.planNode.create({
      data: {
        workOrderNumber,
        seq,
        name: input.name.trim(),
        dept: input.dept,
        phase: input.phase?.trim() || null,
        startDate: input.startDate ?? null,
        planDate: input.planDate,
        note: input.note?.trim() || null,
      },
    })
    if (input.preds !== undefined) await saveDeps(tx, workOrderNumber, node.id, input.preds)
    await assertNoCycle(tx, workOrderNumber)
    if (published) {
      await tx.planChangeLog.create({ data: { workOrderNumber, nodeId: node.id, nodeName: node.name, kind: 'ADD', newDate: node.planDate, reason: input.reason!.trim(), actorId } })
      await requestConfirm(tx, node)
      await clearDelayAlerts(tx, workOrderNumber)
    }
    return { id: node.id }
  })
}

/** 改节点（名称、责任部门、阶段、开始日、计划日、顺序、前置节点、备注）。发布后改计划日要写原因（记调整记录）；改了计划日或责任部门的节点重新请部门确认 */
export async function updateNode(id: string, input: Partial<NodeInput>, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
    if (!cur) throw new FlowError('总计划节点不存在')
    const plan = await lockPlan(tx, cur.workOrderNumber, actorId)
    const old = await tx.planNode.findUnique({ where: { id } })
    if (!old) throw new FlowError('总计划节点不存在')
    const published = plan.status === 'PUBLISHED'
    const dateChanged = input.planDate !== undefined && day(input.planDate) !== day(old.planDate)
    const deptChanged = input.dept !== undefined && input.dept !== old.dept
    if (dateChanged) needReason(published, input.reason, '改计划日期')
    const data: Prisma.PlanNodeUpdateInput = {}
    if (input.name !== undefined) data.name = input.name.trim()
    if (input.dept !== undefined) data.dept = input.dept
    if (input.planDate !== undefined) data.planDate = input.planDate
    if (input.seq != null) data.seq = input.seq
    if (input.note !== undefined) data.note = input.note?.trim() || null
    if (input.phase !== undefined) data.phase = input.phase?.trim() || null
    if (input.startDate !== undefined) data.startDate = input.startDate
    startCheck(input.startDate !== undefined ? input.startDate : old.startDate, input.planDate ?? old.planDate)
    const node = await tx.planNode.update({ where: { id }, data })
    // 前置节点：页面每次保存都会带上，只有真的变了才重写（避免无谓地清掉、重发延误预警）
    let depsChanged = false
    if (input.preds !== undefined) {
      const oldPreds = old.customDeps ? (await tx.planNodeDep.findMany({ where: { nodeId: id }, select: { predId: true } })).map((d) => d.predId).sort() : null
      const newPreds = input.preds == null ? null : [...new Set(input.preds)].sort()
      depsChanged = JSON.stringify(oldPreds) !== JSON.stringify(newPreds)
      if (depsChanged) await saveDeps(tx, node.workOrderNumber, id, input.preds)
    }
    const startChanged = input.startDate !== undefined && (input.startDate ? day(input.startDate) : null) !== (old.startDate ? day(old.startDate) : null)
    const seqChanged = input.seq != null && input.seq !== old.seq
    if (depsChanged || seqChanged) await assertNoCycle(tx, node.workOrderNumber)
    if (published && dateChanged) {
      await tx.planChangeLog.create({
        data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'DATE', oldDate: old.planDate, newDate: node.planDate, reason: input.reason!.trim(), actorId },
      })
    }
    let reconfirm = false
    if (published && (dateChanged || deptChanged)) {
      await requestConfirm(tx, node)
      reconfirm = true
    }
    if (dateChanged || seqChanged || depsChanged || startChanged) await clearDelayAlerts(tx, node.workOrderNumber)
    return { id, reconfirm }
  })
}

/** 删节点：挂在上面的部门记录变成未挂（外键置空），其他任务一起删。发布后删要写原因（记调整记录） */
export async function deleteNode(id: string, reason: string | null | undefined, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
    if (!cur) throw new FlowError('总计划节点不存在')
    const plan = await lockPlan(tx, cur.workOrderNumber, actorId)
    const node = await tx.planNode.findUnique({ where: { id } })
    if (!node) throw new FlowError('总计划节点不存在')
    const published = plan.status === 'PUBLISHED'
    needReason(published, reason, '删节点')
    if (published) {
      await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'DELETE', oldDate: node.planDate, reason: reason!.trim(), actorId } })
    }
    await tx.todo.updateMany({ where: { refType: PLAN_REF, refId: id, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
    // 节点下的其他任务随节点一起删（外键级联），待办作废
    await cancelTaskTodos(tx, (await tx.planTask.findMany({ where: { planNodeId: id }, select: { id: true } })).map((t) => t.id))
    await clearAlertKeys(tx, [w9Key(id), w9ConfirmKey(id), w9SplitKey(id)])
    await tx.planNode.delete({ where: { id } }) // 前置关系两头都级联删除
    // 删掉后，紧跟着它、默认等"上一个节点"的节点改等更前面的节点，可能成环：成环就整笔回滚
    await assertNoCycle(tx, node.workOrderNumber)
    await clearDelayAlerts(tx, node.workOrderNumber)
    return { ok: true }
  })
}

/**
 * 发布：当时的计划日记为基线；每个节点请责任部门负责人确认（发"确认总计划节点"待办）。发布立即生效，不等确认。
 * 返回没有负责人的部门（这些节点没人收到确认待办，设置页"人员与角色"里补上部门负责人后改一下节点即可重新发出）。
 */
export async function publishPlan(workOrderNumber: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    if (plan.status === 'PUBLISHED') throw new FlowError('总计划已经发布过了')
    const nodes = await tx.planNode.findMany({ where: { workOrderNumber }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] })
    if (!nodes.length) throw new FlowError('总计划还没有节点，请先按模板生成或添加节点')
    const now = new Date()
    let todos = 0
    const noHead = new Set<string>()
    for (const n of nodes) {
      await tx.planNode.update({ where: { id: n.id }, data: { baselineDate: n.planDate } })
      const sent = await requestConfirm(tx, n)
      todos += sent
      if (!sent) noHead.add(BUSINESS_DEPT_NAME[n.dept])
    }
    await tx.workOrderPlan.update({ where: { workOrderNumber }, data: { status: 'PUBLISHED', publishedAt: now, publishedBy: actorId } })
    return { nodes: nodes.length, todos, deptsWithoutHead: [...noHead] }
  })
}

async function lockNode(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plan_node WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('总计划节点不存在')
  const node = await tx.planNode.findUniqueOrThrow({ where: { id } })
  const plan = await tx.workOrderPlan.findUnique({ where: { workOrderNumber: node.workOrderNumber }, select: { status: true } })
  return { node, published: plan?.status === 'PUBLISHED' }
}

const closeConfirmTodos = (tx: Tx, id: string, now: Date) =>
  tx.todo.updateMany({ where: { refType: PLAN_REF, refId: id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, data: { status: 'DONE', doneAt: now } })

/** 部门确认节点（待确认、已退回的都可以确认） */
export async function confirmNode(id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const { node, published } = await lockNode(tx, id)
    if (!published || !node.confirmStatus) throw new FlowError('总计划还没有发布，不用确认')
    if (node.confirmStatus === 'CONFIRMED') throw new FlowError('这个节点已经确认过了，请刷新')
    const now = new Date()
    await tx.planNode.update({ where: { id }, data: { confirmStatus: 'CONFIRMED', confirmedBy: actorId, confirmedAt: now, rejectReason: null } })
    await closeConfirmTodos(tx, id, now)
    await clearAlertKeys(tx, [w9ConfirmKey(id)])
    return { id, confirmStatus: 'CONFIRMED' as const }
  })
}

/** 部门退回节点（写原因）：提醒项目经理（没有项目经理时提醒项目部负责人）。项目经理调整日期后自动重新请确认 */
export async function rejectNode(id: string, reason: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const { node, published } = await lockNode(tx, id)
    if (!published || !node.confirmStatus) throw new FlowError('总计划还没有发布，不用确认')
    if (node.confirmStatus !== 'PENDING') throw new FlowError(node.confirmStatus === 'REJECTED' ? '这个节点已经退回了，请刷新' : '这个节点已经确认了')
    const now = new Date()
    await tx.planNode.update({ where: { id }, data: { confirmStatus: 'REJECTED', confirmedBy: actorId, confirmedAt: now, rejectReason: reason.trim() } })
    await closeConfirmTodos(tx, id, now)
    await clearAlertKeys(tx, [w9ConfirmKey(id)])
    const pm = (await tx.workOrderExt.findUnique({ where: { workOrderNumber: node.workOrderNumber }, select: { projectManagerId: true } }))?.projectManagerId
    const to = pm ? [pm] : (await tx.notifyRole.findMany({ where: { role: 'PROJECT_DEPT_HEAD' }, select: { userId: true } })).map((r) => r.userId)
    const who = (await loadNames({ user: [actorId] })).user.get(actorId) ?? actorId
    const title = `【退回】${who}（${BUSINESS_DEPT_NAME[node.dept]}）退回了总计划节点"${node.name}"（计划 ${day(node.planDate)}）：${reason.trim()}（${node.workOrderNumber}）`
    if (to.length) {
      await tx.reminder.createMany({
        data: [...new Set(to)].map((userId) => ({
          userId,
          kind: 'PLAN',
          level: 'YELLOW' as const,
          title: title.length > 190 ? `${title.slice(0, 189)}…` : title,
          link: planLink(node.workOrderNumber, id),
          dedupeKey: `PLAN_REJECT:${id}:${now.getTime()}:${userId}`,
        })),
        skipDuplicates: true,
      })
    }
    return { id, confirmStatus: 'REJECTED' as const, notified: to.length }
  })
}

/** 手动标记节点完成（完成日默认今天、不能晚于今天） */
export async function completeNode(id: string, date: Date | null | undefined, actorId: string, now = new Date()) {
  const d = date ?? todayDate(now)
  if (day(d) > shanghaiDay(now)) throw new FlowError('完成日期不能晚于今天')
  return prisma.$transaction(async (tx) => {
    const { node } = await lockNode(tx, id)
    if (node.manualDoneAt) throw new FlowError('这个节点已经标记完成了，请刷新')
    await tx.planNode.update({ where: { id }, data: { actualDate: d, manualDoneBy: actorId, manualDoneAt: now } })
    await clearAlertKeys(tx, [w9Key(id), w9SplitKey(id)])
    return { id, actualDate: day(d) }
  })
}

/** 撤销手动完成（自动完成的不能撤销：挂靠任务还都是完成状态） */
export async function undoCompleteNode(id: string) {
  return prisma.$transaction(async (tx) => {
    const { node } = await lockNode(tx, id)
    if (!node.manualDoneAt) throw new FlowError('这个节点没有手动标记完成（挂靠任务全部完成时自动完成的不能撤销）')
    await tx.planNode.update({ where: { id }, data: { actualDate: null, manualDoneBy: null, manualDoneAt: null } })
    return { id }
  })
}

/** 节点所属工单和责任部门（接口层判断权限用） */
export async function nodeTarget(id: string) {
  return prisma.planNode.findUnique({ where: { id }, select: { workOrderNumber: true, dept: true } })
}

// ───────────── 我的待办 ─────────────

/** "确认总计划节点"待办的说明：节点名称、工单、计划日、责任部门；节点已删的返回不到 */
export async function describePlanTodos(nodeIds: string[]) {
  if (!nodeIds.length) return new Map<string, { workOrderNumber: string; name: string; planDate: string; deptText: string; link: string }>()
  const nodes = await prisma.planNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, workOrderNumber: true, name: true, planDate: true, dept: true } })
  return new Map(nodes.map((n) => [n.id, { workOrderNumber: n.workOrderNumber, name: n.name, planDate: day(n.planDate), deptText: BUSINESS_DEPT_NAME[n.dept], link: planLink(n.workOrderNumber, n.id) }]))
}
