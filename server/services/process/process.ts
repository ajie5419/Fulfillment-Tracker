/**
 * 工艺模块（10-27，zhao 定）：按部件（设计任务）跟踪料单、工艺两个状态。
 *
 * 只有工艺部、管理员能改（接口层 assertCanOperate 'processDoc'），其他人只读；每次改状态记一条 process_doc_log（谁、什么时候、从什么改成什么）。
 * 已取消的设计任务不能改，也不在列表里。不和"可以开工"挂钩，不做计划日期和预警（第一版，试点后再看）。
 *
 * 设计变更联动：技术部发设计变更时（releases.ts createRelease 同一事务），关联工件所在的设计任务、或从设计任务发放的那个任务，
 * 料单已下发的 → 自动改成"修改中"、记一条变更记录（操作人 = 发放人，releaseId = 这张设计变更），并提醒工艺部负责人。
 *
 * 并发：改状态先锁设计任务行（FOR UPDATE）再按最新状态判断，点两次"下发"第二次会提示"状态已经变了"。
 * 加锁顺序与设计任务一致：工件 → 设计任务 → 发放单（设计变更联动在 createRelease 里，此前只锁了工件和那一个设计任务）。
 */
import { Prisma, type DrawingTaskStatus, type MaterialListStatus, type ProcessDocKind, type ProcessDocStatus, type Release } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { canSee, resolveScope } from '../../utils/auth'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { planNodeLabels } from '../plan/links'
import { DRAWING_STATUS_TEXT } from '../drawings/constants'
import {
  ACTION_TEXT,
  KIND_TEXT,
  MATERIAL_STATUS_TEXT,
  PROCESS_DEPT,
  PROCESS_STATUS_TEXT,
  type ProcessAction,
  type ProcessView,
  allowedActions,
  nextStatus,
  processLink,
  statusText,
} from './constants'

type Tx = Prisma.TransactionClient

const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** 图纸已经发放 = 设计任务状态是 待客户确认 / 已完成（drawings/constants.ts deriveStatus：这两个状态都要求有不是作废状态的发放单） */
export const RELEASED_DRAWING_STATUSES: DrawingTaskStatus[] = ['CUSTOMER_PENDING', 'DONE']

// ───────────── 改状态 ─────────────

export interface ActionInput {
  kind: ProcessDocKind
  action: ProcessAction
  note?: string | null
}

/** 改料单 / 工艺状态（权限在接口层判断）。返回新状态 */
export async function changeStatus(taskId: string, input: ActionInput, actorId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM drawing_task WHERE id = ${taskId} FOR UPDATE`
    if (!rows.length) throw new FlowError('设计任务不存在')
    const task = await tx.drawingTask.findUniqueOrThrow({ where: { id: taskId } })
    if (task.status === 'CANCELLED') throw new FlowError('设计任务已取消，不能再改料单、工艺')
    const current = input.kind === 'MATERIAL' ? task.materialStatus : task.processStatus
    const to = nextStatus(input.kind, current, input.action)
    if (!to) {
      throw new FlowError(`${KIND_TEXT[input.kind]}现在是"${statusText(input.kind, current)}"，不能${ACTION_TEXT[input.action]}，请刷新`)
    }
    const data: Prisma.DrawingTaskUncheckedUpdateInput =
      input.kind === 'MATERIAL'
        ? { materialStatus: to as MaterialListStatus, materialAt: now, materialBy: actorId }
        : { processStatus: to as ProcessDocStatus, processAt: now, processBy: actorId }
    await tx.drawingTask.update({ where: { id: taskId }, data })
    await tx.processDocLog.create({
      data: { taskId, kind: input.kind, fromStatus: current, toStatus: to, note: input.note?.trim() || null, actorId, createdAt: now },
    })
    return { id: taskId, kind: input.kind, status: to, statusText: statusText(input.kind, to) }
  })
}

// ───────────── 设计变更联动 ─────────────

/**
 * 设计变更发出时（createRelease 同一事务里调用）：受影响的设计任务里，料单已下发的改成"修改中"，并提醒工艺部负责人。
 * 受影响 = 关联了这些工件的设计任务，加上从设计任务发放时的那个任务；已取消的不算。
 * 提醒里有工单号：只发给能看到该工单的负责人（resolveScope）。没有设工艺部负责人时不提醒，返回 notified=false。
 */
export async function markRevisingByChange(tx: Tx, release: Pick<Release, 'id' | 'releaseNo' | 'workOrderNumber' | 'issuerId'>, partIds: string[], taskId: string | null, now = new Date()) {
  const linked = partIds.length ? await tx.drawingTaskPart.findMany({ where: { partId: { in: partIds } }, select: { taskId: true } }) : []
  const ids = uniq([...linked.map((l) => l.taskId), ...(taskId ? [taskId] : [])]).sort()
  if (!ids.length) return { revising: 0, notified: false }
  // 按 ID 顺序锁，再按最新状态筛（并发改状态的那边也是先锁行）
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM drawing_task WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
  const tasks = await tx.drawingTask.findMany({
    where: { id: { in: locked.map((l) => l.id) }, workOrderNumber: release.workOrderNumber, materialStatus: 'ISSUED', status: { not: 'CANCELLED' } },
    select: { id: true, componentName: true },
    orderBy: { id: 'asc' },
  })
  if (!tasks.length) return { revising: 0, notified: false }
  const note = `设计变更 ${release.releaseNo}`
  await tx.drawingTask.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { materialStatus: 'REVISING', materialAt: now, materialBy: release.issuerId } })
  await tx.processDocLog.createMany({
    data: tasks.map((t) => ({ taskId: t.id, kind: 'MATERIAL' as const, fromStatus: 'ISSUED', toStatus: 'REVISING', note, releaseId: release.id, actorId: release.issuerId, createdAt: now })),
  })
  const heads = await tx.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: PROCESS_DEPT }, select: { userId: true } })
  const candidates = uniq(heads.map((h) => h.userId))
  const active = candidates.length
    ? (await tx.qmsUser.findMany({ where: { id: { in: candidates }, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })).map((u) => u.id)
    : []
  // 提醒里有工单号和部件名：看不到该工单的人不发（规则 10-26 #37）
  const users: string[] = []
  for (const id of active) if (canSee(await resolveScope(id, false), release.workOrderNumber)) users.push(id)
  if (users.length) {
    const names = tasks.map((t) => t.componentName).join('、')
    const raw = `【料单要改】设计变更 ${release.releaseNo} 涉及已下发的料单，已改为"修改中"：${names}（${release.workOrderNumber}）`
    const title = raw.length > 190 ? `${raw.slice(0, 189)}…` : raw
    await tx.reminder.createMany({
      data: users.map((userId) => ({ userId, kind: 'PROCESS', level: 'YELLOW' as const, title, link: processLink(release.workOrderNumber, 'revising'), dedupeKey: `PROCESS_REVISE:${release.id}:${userId}` })),
      skipDuplicates: true,
    })
  }
  return { revising: tasks.length, notified: users.length > 0 }
}

// ───────────── 查询 ─────────────

export interface ListFilter {
  workOrderNumber?: string
  view?: ProcessView
  q?: string
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
}

const MAX_LIST_ROWS = 500

function viewWhere(view: ProcessView): Prisma.DrawingTaskWhereInput {
  switch (view) {
    case 'todo':
      return { OR: [{ materialStatus: { not: 'ISSUED' } }, { processStatus: 'DRAFTING' }] }
    case 'waiting':
      return { status: { in: RELEASED_DRAWING_STATUSES }, materialStatus: 'NOT_STARTED' }
    case 'drafting':
      return { OR: [{ materialStatus: 'DRAFTING' }, { processStatus: 'DRAFTING' }] }
    case 'revising':
      return { materialStatus: 'REVISING' }
    case 'issued':
      return { materialStatus: 'ISSUED', processStatus: { not: 'DRAFTING' } }
    default:
      return {}
  }
}

/** 统计：按可见范围、所选工单，不受视图和搜索影响 */
async function stats(scope: Prisma.DrawingTaskWhereInput[]) {
  const count = (w: Prisma.DrawingTaskWhereInput) => prisma.drawingTask.count({ where: { AND: [...scope, w] } })
  const [waiting, drafting, revising, materialIssued, processDrafting, processIssued, total] = await Promise.all([
    count(viewWhere('waiting')),
    count({ materialStatus: 'DRAFTING' }),
    count({ materialStatus: 'REVISING' }),
    count({ materialStatus: 'ISSUED' }),
    count({ processStatus: 'DRAFTING' }),
    count({ processStatus: 'ISSUED' }),
    count({}),
  ])
  return { waiting, drafting, revising, materialIssued, processDrafting, processIssued, total }
}

/**
 * 工艺页列表 + 统计：未取消的设计任务（部件），带料单、工艺状态和设计进度。
 * 排序：料单状态（未开始 → 编制中 → 修改中 → 已下发）→ 建立时间。canEdit = 看的人能不能改（工艺部、管理员），决定返回哪些按钮。
 */
export async function listProcess(filter: ListFilter, canEdit: boolean) {
  const scope: Prisma.DrawingTaskWhereInput[] = [{ status: { not: 'CANCELLED' } }]
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  const q = filter.q?.trim()
  const search: Prisma.DrawingTaskWhereInput[] = q ? [{ OR: [{ componentName: { contains: q } }, { workOrderNumber: { contains: q } }] }] : []
  const where: Prisma.DrawingTaskWhereInput = { AND: [...scope, viewWhere(filter.view ?? 'todo'), ...search] }
  const [found, total, st] = await Promise.all([
    prisma.drawingTask.findMany({
      where,
      include: { parts: { select: { partId: true } } },
      orderBy: [{ materialStatus: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_LIST_ROWS,
    }),
    prisma.drawingTask.count({ where }),
    stats(scope),
  ])
  const partIds = uniq(found.flatMap((r) => r.parts.map((p) => p.partId)))
  const ids = found.map((r) => r.id)
  const [parts, names, releases, planNodes] = await Promise.all([
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true, drawingNo: true } }) : [],
    loadNames({ user: found.flatMap((r) => [r.materialBy, r.processBy]) }),
    ids.length
      ? prisma.release.findMany({ where: { drawingTaskId: { in: ids }, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true, releaseNo: true, drawingTaskId: true, createdAt: true } })
      : [],
    planNodeLabels(found.map((r) => r.planNodeId)),
  ])
  const partOf = new Map(parts.map((p) => [p.id, p]))
  const user = (id: string | null) => (id ? (names.user.get(id) ?? id) : null)
  const rows = found.map((t) => {
    const mine = releases.filter((r) => r.drawingTaskId === t.id)
    return {
      id: t.id,
      workOrderNumber: t.workOrderNumber,
      componentName: t.componentName,
      drawingStatus: t.status,
      drawingStatusText: DRAWING_STATUS_TEXT[t.status],
      /** 图纸已发放（最近一张不是作废的发放单） */
      drawingRelease: mine.length ? { id: mine[mine.length - 1]!.id, releaseNo: mine[mine.length - 1]!.releaseNo, at: mine[mine.length - 1]!.createdAt } : null,
      partIds: t.parts.map((p) => p.partId),
      parts: t.parts.map((p) => {
        const part = partOf.get(p.partId)
        return { id: p.partId, name: part ? (part.drawingNo ? `${part.name}（${part.drawingNo}）` : part.name) : '（已删除的工件）' }
      }),
      planNode: (t.planNodeId && planNodes.get(t.planNodeId)) || null,
      materialStatus: t.materialStatus,
      materialStatusText: MATERIAL_STATUS_TEXT[t.materialStatus],
      materialAt: t.materialAt,
      materialByName: user(t.materialBy),
      processStatus: t.processStatus,
      processStatusText: PROCESS_STATUS_TEXT[t.processStatus],
      processAt: t.processAt,
      processByName: user(t.processBy),
      actions: {
        material: canEdit ? allowedActions('MATERIAL', t.materialStatus) : [],
        process: canEdit ? allowedActions('PROCESS', t.processStatus) : [],
      },
    }
  })
  return { rows, total, stats: st }
}

/** 一个部件的料单、工艺变更记录（新的在前）。调用前接口层已校验能看到该工单 */
export async function listLogs(taskId: string) {
  const task = await prisma.drawingTask.findUnique({ where: { id: taskId }, select: { id: true, componentName: true, workOrderNumber: true } })
  if (!task) throw new FlowError('设计任务不存在')
  const logs = await prisma.processDocLog.findMany({ where: { taskId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })
  const relIds = uniq(logs.map((l) => l.releaseId).filter((x): x is string => !!x))
  const [names, rels] = await Promise.all([
    loadNames({ user: logs.map((l) => l.actorId) }),
    relIds.length ? prisma.release.findMany({ where: { id: { in: relIds } }, select: { id: true, releaseNo: true } }) : [],
  ])
  const relNo = new Map(rels.map((r) => [r.id, r.releaseNo]))
  return {
    ...task,
    logs: logs.map((l) => ({
      id: l.id,
      kind: l.kind,
      kindText: KIND_TEXT[l.kind],
      fromText: statusText(l.kind, l.fromStatus),
      toText: statusText(l.kind, l.toStatus),
      note: l.note,
      actorName: names.user.get(l.actorId) ?? l.actorId,
      release: l.releaseId ? { id: l.releaseId, releaseNo: relNo.get(l.releaseId) ?? null } : null,
      /** 设计变更自动改的 */
      auto: !!l.releaseId,
      createdAt: l.createdAt,
    })),
  }
}
