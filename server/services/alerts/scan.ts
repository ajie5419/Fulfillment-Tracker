/**
 * scan-rules：一次跑完 W1–W5，新建、升级、消除预警，并给升级阶梯上的人写"我的提醒"（方案 6.2）。
 *
 * 幂等：同一对象同一规则只有一条活动预警（alert.activeKey 唯一）；同一人同一预警同一级别只有一条提醒
 * （reminder 上 alertId+level+userId 唯一）。每轮都会把当前级别该收到的人补齐，所以中途失败下一轮自动补上。
 * 整个扫描用 job_lock 租约锁防重叠，拿不到锁直接返回。
 *
 * 红色自动转异常（W1–W3）：升到红色、通知照常发出后，在同一事务里生成异常（来源"预警转入"），预警改为"已转异常"。
 * 已转异常的预警保留 activeKey（同一对象不会马上又生成一条新预警），不再升级、不再通知；
 * 对象离开规则关注的状态时只把 activeKey 置空，状态保持"已转异常"。
 */
import type { Alert, AlertLevel, NotifyRole, StepMode } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { ARRANGE_SEND, ARRANGE_START } from '../flow/flow'
import { loadNames, userDepartmentNames } from '../flow/names'
import { convertAlertInTx } from '../issues/convert'
import { CATEGORY_TEXT } from '../issues/constants'
import { issueTransaction } from '../issues/issues'
import { withLease } from '../jobs/lease'
import { CONFIRM_CHANGE, TYPE_TEXT } from '../releases/constants'
import { SCAN_RULES, loadOffDays, loadThresholds } from './config'
import {
  CONVERTIBLE_RULES,
  type ScanRule,
  alertKey,
  type Thresholds,
  dateFieldDay,
  durationText,
  elapsedExcludingOffDays,
  isHigher,
  judgeW3,
  judgeW4,
  levelByElapsed,
  maxLevel,
  reminderTitle,
} from './rules'

export { SCAN_RULES, loadOffDays, loadThresholds }

/** 一个处在规则关注状态的对象（不一定已到阈值） */
export interface Target {
  rule: ScanRule
  refType: 'step' | 'unmatched' | 'issue' | 'receipt' | 'release'
  refId: string
  key: string
  workOrderNumber: string | null
  /** 责任人 */
  ownerIds: string[]
  /** 黄色起额外通知的人（W5：发放人，要知道谁一直没签收 / 变更影响一直没人确认） */
  watcherIds?: string[]
  /** 黄色起要通知的"责任部门"名称；不给时取责任人所在部门（W4 的责任部门是异常上明确写的） */
  deptNames?: string[]
  /** 计时起点（W3 为承诺返回日） */
  startAt: Date
  /** 按当前时长/日期算出的级别，没到阈值为 null */
  level: AlertLevel | null
  /** 标题里冒号前的部分，如"主梁结构件 · 涂装" */
  subject: string
  /** 标题里冒号后的部分，如"组焊返厂 2 天仍未发出" */
  summary: string
  /** 转异常时定分类用；W5 带发放单 ID（跳转用） */
  meta?: { stepMode?: StepMode; supplierId?: string | null; releaseId?: string }
}

/** 收集 W1–W5 关注的全部对象，并按 now 判定级别；only 只收集某一条规则 */
export async function collectTargets(now: Date, t: Thresholds, offDays: string[], only?: ScanRule): Promise<Target[]> {
  const run = (rule: ScanRule, fn: () => Promise<Target[]>) => (!only || only === rule ? fn() : Promise.resolve([]))
  const parts = await Promise.all([
    run('W1', () => collectW1(now, t, offDays)),
    run('W2', () => collectW2(now, t, offDays)),
    run('W3', () => collectW3(now, t, offDays)),
    run('W4', () => collectW4(now, t, offDays)),
    run('W5', () => collectW5(now, t, offDays)),
  ])
  return parts.flat()
}

/** W1：待确认匹配，责任人是全部外协专员 */
async function collectW1(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rows = await prisma.unmatchedInspection.findMany({ where: { status: 'PENDING' } })
  if (!rows.length) return []
  const [inspections, coordinators] = await Promise.all([
    prisma.qmsInspection.findMany({ where: { id: { in: rows.map((r) => r.qmsInspectionId) } } }),
    prisma.notifyRole.findMany({ where: { role: 'OUTSOURCE_COORDINATOR' }, select: { userId: true } }),
  ])
  const byId = new Map(inspections.map((i) => [i.id, i]))
  const owners = [...new Set(coordinators.map((c) => c.userId))]
  return rows.map((r) => {
    const ins = byId.get(r.qmsInspectionId)
    const elapsed = elapsedExcludingOffDays(r.createdAt, now, offDays)
    const what = [ins?.partName, ins?.processName].filter(Boolean).join(' · ') || r.qmsInspectionId
    return {
      rule: 'W1',
      refType: 'unmatched',
      refId: r.qmsInspectionId,
      key: alertKey('W1', 'unmatched', r.qmsInspectionId),
      workOrderNumber: ins?.workOrderNumber ?? null,
      ownerIds: owners,
      startAt: r.createdAt,
      level: levelByElapsed(elapsed, t.W1),
      subject: `待确认匹配 ${what}`,
      summary: `返厂报检 ${durationText(elapsed)}未确认关联`,
      meta: { supplierId: ins?.supplierId ?? null },
    }
  })
}

/**
 * W2：待开工且有"安排发出/开工"待办的步骤，从最早一条待办起计时（转交不重新计时），责任人是当前待办负责人。
 * 上一道"有异常"（QMS 不合格，已经有异常在跟）时不计时、不预警，避免与异常重复报警；
 * 上一道的异常关闭后从关闭时刻重新计时（取 待办生成 与 上一道最近一次异常关闭 中较晚的）。
 * 标了"等变更"（R9 设计变更发放时还没开工）的步骤不计时；解除后从解除时刻重新计时。
 */
async function collectW2(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const actions = [ARRANGE_SEND, ARRANGE_START]
  const open = await prisma.todo.findMany({ where: { refType: 'step', action: { in: actions }, status: 'OPEN' } })
  if (!open.length) return []
  const stepIds = [...new Set(open.map((o) => o.refId))]
  const [steps, transferred] = await Promise.all([
    prisma.routeStep.findMany({ where: { id: { in: stepIds }, status: 'PENDING', holdReleaseId: null }, include: { part: true } }),
    prisma.todo.findMany({ where: { refType: 'step', refId: { in: stepIds }, action: { in: actions }, status: 'TRANSFERRED' }, select: { refId: true, createdAt: true } }),
  ])
  if (!steps.length) return []
  const prevSteps = await prisma.routeStep.findMany({
    where: { OR: steps.map((s) => ({ partId: s.partId, seq: { lt: s.seq } })) },
    orderBy: { seq: 'desc' },
  })
  const prevOf = (s: (typeof steps)[number]) => prevSteps.find((p) => p.partId === s.partId && p.seq < s.seq)
  const prevIds = [...new Set(steps.map((s) => prevOf(s)?.id).filter((x): x is string => !!x))]
  const [names, closes] = await Promise.all([
    loadNames({ process: [...steps, ...prevSteps].map((s) => s.processId) }),
    prevIds.length
      ? prisma.issueLog.findMany({
          where: { toStatus: 'CLOSED', issue: { refType: 'STEP', refId: { in: prevIds } } },
          select: { createdAt: true, issue: { select: { refId: true } } },
        })
      : [],
  ])
  const lastClose = new Map<string, number>()
  for (const c of closes) lastClose.set(c.issue.refId!, Math.max(lastClose.get(c.issue.refId!) ?? 0, +c.createdAt))

  const out: Target[] = []
  for (const s of steps) {
    const prev = prevOf(s)
    if (prev?.status === 'BLOCKED') continue
    const mine = open.filter((o) => o.refId === s.id)
    const todoStart = Math.min(...[...mine, ...transferred.filter((x) => x.refId === s.id)].map((x) => +x.createdAt))
    const startAt = new Date(Math.max(todoStart, (prev && lastClose.get(prev.id)) || 0, s.holdClearedAt ? +s.holdClearedAt : 0))
    const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
    const verb = s.mode === 'EXTERNAL_OUTSOURCE' ? '发出' : '开工'
    out.push({
      rule: 'W2',
      refType: 'step',
      refId: s.id,
      key: alertKey('W2', 'step', s.id),
      workOrderNumber: s.part.workOrderNumber,
      ownerIds: [...new Set(mine.map((o) => o.ownerId))],
      startAt,
      level: levelByElapsed(elapsed, t.W2),
      subject: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}`,
      summary: `${prev ? `${names.process.get(prev.processId) ?? prev.processId}返厂` : '待安排'} ${durationText(elapsed)}仍未${verb}`,
      meta: { stepMode: s.mode, supplierId: s.supplierId },
    })
  }
  return out
}

/** W3：在外加工且有承诺返回日的步骤，责任人是步骤负责人。标了"等变更"的不计（变更影响确认后恢复） */
async function collectW3(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const steps = await prisma.routeStep.findMany({ where: { status: 'OUT', promisedReturnDate: { not: null }, holdReleaseId: null }, include: { part: true } })
  if (!steps.length) return []
  const names = await loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) })
  return steps.map((s) => {
    const r = judgeW3({ promisedReturnDate: s.promisedReturnDate!, dueDate: s.dueDate, now, offDays }, t.W3)
    const supplier = s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : '外协厂'
    const summary = r.dueDatePassed
      ? `已过要求完成日 ${dateFieldDay(s.dueDate!)}，${supplier}仍未返回`
      : r.overdueDays > 0
        ? `${supplier}超承诺返回日 ${r.overdueDays} 天未返`
        : r.daysLeft > 0
          ? `${supplier}承诺 ${dateFieldDay(s.promisedReturnDate!)} 返回，还剩 ${r.daysLeft} 天`
          : `${supplier}承诺今天返回`
    return {
      rule: 'W3',
      refType: 'step',
      refId: s.id,
      key: alertKey('W3', 'step', s.id),
      workOrderNumber: s.part.workOrderNumber,
      ownerIds: s.ownerId ? [s.ownerId] : [],
      startAt: s.promisedReturnDate!,
      level: r.level,
      subject: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}`,
      summary,
      meta: { stepMode: s.mode, supplierId: s.supplierId },
    }
  })
}

/**
 * W4：待受理、处理中的异常。责任人是异常责任人，没有时是项目部负责人；
 * 黄色起通知异常上写明的责任部门的负责人（不是责任人所在部门）。
 */
async function collectW4(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const issues = await prisma.issue.findMany({ where: { status: { in: ['OPEN', 'ACCEPTED'] } } })
  if (!issues.length) return []
  const [pdh, depts] = await Promise.all([
    prisma.notifyRole.findMany({ where: { role: 'PROJECT_DEPT_HEAD' }, select: { userId: true } }),
    prisma.qmsDepartment.findMany({ where: { id: { in: issues.map((i) => i.responsibleDeptId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ])
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const fallback = [...new Set(pdh.map((p) => p.userId))]
  return issues.map((i) => {
    const r = judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, t.W4)
    const summary =
      r.overdueDays > 0
        ? `超要求解决日 ${dateFieldDay(i.dueDate!)} ${r.overdueDays} 天未解决`
        : i.status === 'OPEN'
          ? `待受理 ${durationText(r.openMs)}`
          : `要求 ${i.dueDate ? dateFieldDay(i.dueDate) : '—'} 前解决`
    const dept = i.responsibleDeptId ? deptName.get(i.responsibleDeptId) : undefined
    return {
      rule: 'W4',
      refType: 'issue',
      refId: i.id,
      key: alertKey('W4', 'issue', i.id),
      workOrderNumber: i.workOrderNumber,
      ownerIds: i.responsibleUserId ? [i.responsibleUserId] : fallback,
      deptNames: dept ? [dept] : undefined,
      startAt: i.status === 'OPEN' && !r.overdueDays ? i.createdAt : (i.dueDate ?? i.createdAt),
      level: r.level,
      subject: `异常 ${i.issueNo}（${CATEGORY_TEXT[i.category]}）`,
      summary,
    }
  })
}

/**
 * W5 发放未签收（R9）：有效发放单上待签收的签收记录，从发放起计时（不含停工日）。
 * 责任人是接收人；黄色起加通知发放人（以及按升级阶梯：接收人所在部门负责人、工单项目经理），红色再加项目部负责人、分管领导。
 * 设计变更的"确认变更影响"同样按 W5 计时（见 collectW5Changes），保证"等变更"不会无声地一直挂着。
 */
async function collectW5(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const [receipts, changes] = await Promise.all([collectW5Receipts(now, t, offDays), collectW5Changes(now, t, offDays)])
  return [...receipts, ...changes]
}

async function collectW5Receipts(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rows = await prisma.releaseReceipt.findMany({ where: { status: 'PENDING', release: { status: 'ACTIVE' } }, include: { release: true } })
  if (!rows.length) return []
  const names = await loadNames({ user: rows.map((r) => r.userId) })
  return rows.map((r) => {
    const rel = r.release
    const elapsed = elapsedExcludingOffDays(r.createdAt, now, offDays)
    return {
      rule: 'W5',
      refType: 'receipt',
      refId: r.id,
      key: alertKey('W5', 'receipt', r.id),
      workOrderNumber: rel.workOrderNumber,
      ownerIds: [r.userId],
      watcherIds: [rel.issuerId],
      startAt: r.createdAt,
      level: levelByElapsed(elapsed, t.W5),
      subject: `${TYPE_TEXT[rel.type]} ${rel.releaseNo}${rel.version ? `（${rel.version}）` : ''}`,
      summary: `已发放 ${durationText(elapsed)}，${names.user.get(r.userId) ?? r.userId}仍未签收`,
      meta: { releaseId: rel.id },
    }
  })
}

/**
 * W5 变更影响未确认：有效、未确认的设计变更，只要
 * - 还有打开的"确认变更影响"待办：责任人是待办人（生产经理、外协专员），从最早发出确认待办起计时；或
 * - 还有"等变更"的工序、却已没有待签收的人（有人拒收，自动解除走不通）：责任人是发放人，从发放起计时。
 * 两种都是黄色起加通知发放人。确认 / 作废后对象消失，告警解除。
 */
async function collectW5Changes(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rels = await prisma.release.findMany({ where: { type: 'CHANGE', status: 'ACTIVE', changeConfirmedAt: null } })
  if (!rels.length) return []
  const ids = rels.map((r) => r.id)
  const [todos, held, pending] = await Promise.all([
    prisma.todo.findMany({ where: { refType: 'release', refId: { in: ids }, action: CONFIRM_CHANGE, status: { in: ['OPEN', 'TRANSFERRED'] } }, select: { refId: true, ownerId: true, status: true, createdAt: true } }),
    prisma.routeStep.groupBy({ by: ['holdReleaseId'], where: { holdReleaseId: { in: ids } }, _count: { _all: true } }),
    prisma.releaseReceipt.groupBy({ by: ['releaseId'], where: { releaseId: { in: ids }, status: 'PENDING' }, _count: { _all: true } }),
  ])
  const heldOf = new Map(held.map((h) => [h.holdReleaseId, h._count._all]))
  const pendingOf = new Map(pending.map((p) => [p.releaseId, p._count._all]))
  const out: Target[] = []
  const pick: { rel: (typeof rels)[number]; owners: string[]; startAt: Date }[] = []
  for (const rel of rels) {
    const mine = todos.filter((x) => x.refId === rel.id)
    const open = [...new Set(mine.filter((x) => x.status === 'OPEN').map((x) => x.ownerId))]
    if (open.length) {
      // 转交过的从最早发出起算，转交不重新计时
      const startAt = new Date(Math.min(...mine.map((x) => x.createdAt.getTime())))
      pick.push({ rel, owners: open, startAt })
    } else if ((heldOf.get(rel.id) ?? 0) > 0 && !pendingOf.get(rel.id)) {
      pick.push({ rel, owners: [rel.issuerId], startAt: rel.createdAt })
    }
  }
  if (!pick.length) return out
  const names = await loadNames({ user: pick.flatMap((x) => x.owners) })
  for (const { rel, owners, startAt } of pick) {
    const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
    const who = owners.map((id) => names.user.get(id) ?? id).join('、')
    out.push({
      rule: 'W5',
      refType: 'release',
      refId: rel.id,
      key: alertKey('W5', 'release', rel.id),
      workOrderNumber: rel.workOrderNumber,
      ownerIds: owners,
      watcherIds: [rel.issuerId],
      startAt,
      level: levelByElapsed(elapsed, t.W5),
      subject: `${TYPE_TEXT[rel.type]} ${rel.releaseNo}${rel.version ? `（${rel.version}）` : ''}`,
      summary: `已发放 ${durationText(elapsed)}，变更影响仍未确认（待 ${who} 确认）`,
      meta: { releaseId: rel.id },
    })
  }
  return out
}

// ───────────── 通知对象 ─────────────

interface NotifyContext {
  roles: NotifyRole[]
  deptOf: Map<string, string>
  pmOf: Map<string, string | null>
}

export async function loadNotifyContext(targets: Pick<Target, 'ownerIds' | 'workOrderNumber'>[]): Promise<NotifyContext> {
  const ownerIds = [...new Set(targets.flatMap((x) => x.ownerIds))]
  const wos = [...new Set(targets.map((x) => x.workOrderNumber).filter((w): w is string => !!w))]
  const [roles, deptOf, exts] = await Promise.all([
    prisma.notifyRole.findMany(),
    // 用户的部门是部门 ID，换成名称后与 notify_role.department（部门名称）对应
    userDepartmentNames(ownerIds),
    wos.length ? prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } } }) : [],
  ])
  return {
    roles,
    deptOf,
    pmOf: new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId])),
  }
}

/**
 * 升级阶梯（方案 6.2）：
 *   提醒 = 责任人；黄 = 提醒 + 责任部门负责人 + 工单项目经理（+ watcherIds，如 W5 的发放人）；红 = 黄 + 项目部负责人 + 分管领导。
 * 责任部门（名称）：target.deptNames（W4 异常上写明的），没有时取责任人所在部门（部门 ID 经 qms_department 换成名称）。
 * 找不到的角色跳过，收件人去重。
 */
export function recipientsFor(level: AlertLevel, target: Pick<Target, 'ownerIds' | 'workOrderNumber' | 'deptNames' | 'watcherIds'>, ctx: NotifyContext): string[] {
  const out = new Set(target.ownerIds)
  if (level === 'YELLOW' || level === 'RED') {
    for (const id of target.watcherIds ?? []) out.add(id)
    const depts = new Set(target.deptNames ?? target.ownerIds.map((id) => ctx.deptOf.get(id)).filter(Boolean))
    for (const r of ctx.roles) if (r.role === 'DEPT_HEAD' && r.department && depts.has(r.department)) out.add(r.userId)
    const pm = target.workOrderNumber ? ctx.pmOf.get(target.workOrderNumber) : null
    if (pm) out.add(pm)
  }
  if (level === 'RED') {
    for (const r of ctx.roles) if (r.role === 'PROJECT_DEPT_HEAD' || r.role === 'LEADER') out.add(r.userId)
  }
  return [...out]
}

// ───────────── 扫描 ─────────────

export interface ScanResult {
  skipped: boolean
  created: number
  escalated: number
  cleared: number
  reminders: number
  active: number
  /** 本轮红色自动转成异常的条数 */
  converted: number
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'

const LOCK_NAME = 'scan-rules'
/** 租约时长：远大于一轮扫描的耗时；进程崩溃后最多这么久自动失效 */
const LEASE_MS = 10 * 60_000

const EMPTY: ScanResult = { skipped: true, created: 0, escalated: 0, cleared: 0, reminders: 0, active: 0, converted: 0 }

/**
 * 跑一轮扫描。now 可注入（测试、演示"快进时钟"）。
 * 防重叠：job_lock 表上的租约锁，抢不到直接返回 skipped。
 */
export async function scanRules(now = new Date()): Promise<ScanResult> {
  const r = await withLease(LOCK_NAME, LEASE_MS, () => runScan(now))
  return r.skipped ? { ...EMPTY } : r.value
}

async function runScan(now: Date): Promise<ScanResult> {
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const targets = await collectTargets(now, thresholds, offDays)
  // 活动的、以及已转异常但对象仍在关注状态的（activeKey 还在）
  const keyed = await prisma.alert.findMany({ where: { activeKey: { not: null }, status: { in: ['ACTIVE', 'CONVERTED'] }, rule: { in: SCAN_RULES } } })
  const byKey = new Map(keyed.map((a) => [a.activeKey!, a]))
  const ctx = await loadNotifyContext(targets)
  const result: ScanResult = { ...EMPTY, skipped: false }

  for (const target of targets) {
    let alert: Alert | null = byKey.get(target.key) ?? null
    if (alert?.status === 'CONVERTED') continue // 已转异常：不再升级、不再通知
    if (!alert) {
      if (!target.level) continue
      try {
        alert = await prisma.alert.create({
          data: {
            rule: target.rule,
            refType: target.refType,
            refId: target.refId,
            level: target.level,
            firstAt: now,
            levelAt: now,
            activeKey: target.key,
          },
        })
        result.created++
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        alert = await prisma.alert.findUnique({ where: { activeKey: target.key } }) // 并发下别处刚建好
        if (!alert) continue
      }
    }
    // 升级、写提醒、红色转异常在同一事务里，并先锁住预警行：业务事务（发出、返厂、关联）同时在消除它时，
    // 两边串行，已消除的预警不会再被升级或补发提醒。异常编号撞车时整个事务重来（提醒 skipDuplicates，重来无副作用）
    const existed = alert
    const outcome = await issueTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM alert WHERE id = ${existed.id} FOR UPDATE`
      let a = await tx.alert.findUnique({ where: { id: existed.id } })
      if (!a || a.status !== 'ACTIVE') return null
      let escalated = false
      // 只升不降：阈值调大或计时变短都不退级
      const next = maxLevel(a.level, target.level)!
      if (isHigher(next, a.level)) {
        a = await tx.alert.update({ where: { id: a.id }, data: { level: next, levelAt: now } })
        escalated = true
      }
      // 当前级别该收到的人补齐（已有的跳过）
      const users = recipientsFor(a.level, target, ctx)
      let count = 0
      if (users.length) {
        const title = reminderTitle(a.level, target.subject, target.summary, target.workOrderNumber)
        count = (await tx.reminder.createMany({ data: users.map((userId) => ({ userId, alertId: a!.id, level: a!.level, title })), skipDuplicates: true })).count
        if (count) await tx.alert.update({ where: { id: a.id }, data: { lastNotifiedAt: new Date() } })
      }
      // 红色自动转异常（W4 本身就是异常，不转）
      let converted = false
      if (a.level === 'RED' && CONVERTIBLE_RULES.includes(target.rule) && target.workOrderNumber) {
        await convertAlertInTx(tx, a, target, null)
        converted = true
      }
      return { escalated, count, converted }
    })
    if (!outcome) continue
    if (outcome.converted) result.converted++
    else result.active++
    if (outcome.escalated) result.escalated++
    result.reminders += outcome.count
  }

  // 对象已离开规则关注的状态（已处理、已发出/开工、已返厂、异常已受理处理）→ 活动的消除；已转异常的只释放 activeKey
  const live = new Set(targets.map((x) => x.key))
  const gone = keyed.filter((a) => !live.has(a.activeKey!))
  const goneActive = gone.filter((a) => a.status === 'ACTIVE').map((a) => a.id)
  const goneConverted = gone.filter((a) => a.status === 'CONVERTED').map((a) => a.id)
  if (goneActive.length) {
    const { count } = await prisma.alert.updateMany({ where: { id: { in: goneActive }, status: 'ACTIVE' }, data: { status: 'CLEARED', activeKey: null } })
    result.cleared = count
  }
  if (goneConverted.length) await prisma.alert.updateMany({ where: { id: { in: goneConverted }, status: 'CONVERTED' }, data: { activeKey: null } })
  return result
}
