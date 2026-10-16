/**
 * scan-rules：一次跑完 W1–W3，新建、升级、消除预警，并给升级阶梯上的人写"我的提醒"（方案 6.2）。
 *
 * 幂等：同一对象同一规则只有一条活动预警（alert.activeKey 唯一）；同一人同一预警同一级别只有一条提醒
 * （reminder 上 alertId+level+userId 唯一）。每轮都会把当前级别该收到的人补齐，所以中途失败下一轮自动补上。
 * 整个扫描用 job_lock 租约锁防重叠，拿不到锁直接返回。
 *
 * TODO(R5)：W4 异常超期、红色预警自动转为异常，跟异常模块（录入、受理、处理界面）一起做。
 */
import { randomUUID } from 'node:crypto'
import type { Alert, AlertLevel, NotifyRole } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { ARRANGE_SEND, ARRANGE_START } from '../flow/flow'
import { loadNames } from '../flow/names'
import {
  DEFAULT_THRESHOLDS,
  type ScanRule,
  alertKey,
  type Thresholds,
  dateFieldDay,
  durationText,
  elapsedExcludingOffDays,
  isHigher,
  judgeW3,
  levelByElapsed,
  maxLevel,
  reminderTitle,
} from './rules'

export const SCAN_RULES: ScanRule[] = ['W1', 'W2', 'W3']

/** 一个处在规则关注状态的对象（不一定已到阈值） */
export interface Target {
  rule: ScanRule
  refType: 'step' | 'unmatched'
  refId: string
  key: string
  workOrderNumber: string | null
  /** 责任人 */
  ownerIds: string[]
  /** 计时起点（W3 为承诺返回日） */
  startAt: Date
  /** 按当前时长/日期算出的级别，没到阈值为 null */
  level: AlertLevel | null
  /** 标题里冒号前的部分，如"主梁结构件 · 涂装" */
  subject: string
  /** 标题里冒号后的部分，如"组焊返厂 2 天仍未发出" */
  summary: string
}

export async function loadThresholds(): Promise<Thresholds> {
  const rows = await prisma.threshold.findMany({ where: { rule: { in: SCAN_RULES } } })
  const t: Thresholds = structuredClone(DEFAULT_THRESHOLDS)
  for (const r of rows) t[r.rule as ScanRule] = { remindHours: r.remindHours, yellowDays: r.yellowDays, redDays: r.redDays }
  return t
}

export async function loadOffDays(): Promise<string[]> {
  return (await prisma.offDay.findMany()).map((d) => dateFieldDay(d.date))
}

/** 收集 W1–W3 关注的全部对象，并按 now 判定级别 */
export async function collectTargets(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const [w1, w2, w3] = await Promise.all([collectW1(now, t, offDays), collectW2(now, t, offDays), collectW3(now, t, offDays)])
  return [...w1, ...w2, ...w3]
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
    }
  })
}

/** W2：待开工且有"安排发出/开工"待办的步骤，从最早一条待办起计时（转交不重新计时），责任人是当前待办负责人 */
async function collectW2(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const actions = [ARRANGE_SEND, ARRANGE_START]
  const open = await prisma.todo.findMany({ where: { refType: 'step', action: { in: actions }, status: 'OPEN' } })
  if (!open.length) return []
  const stepIds = [...new Set(open.map((o) => o.refId))]
  const [steps, transferred] = await Promise.all([
    prisma.routeStep.findMany({ where: { id: { in: stepIds }, status: 'PENDING' }, include: { part: true } }),
    prisma.todo.findMany({ where: { refType: 'step', refId: { in: stepIds }, action: { in: actions }, status: 'TRANSFERRED' }, select: { refId: true, createdAt: true } }),
  ])
  if (!steps.length) return []
  const prevSteps = await prisma.routeStep.findMany({
    where: { OR: steps.map((s) => ({ partId: s.partId, seq: { lt: s.seq } })) },
    orderBy: { seq: 'desc' },
  })
  const names = await loadNames({ process: [...steps, ...prevSteps].map((s) => s.processId) })
  return steps.map((s) => {
    const mine = open.filter((o) => o.refId === s.id)
    const startAt = new Date(Math.min(...[...mine, ...transferred.filter((x) => x.refId === s.id)].map((x) => +x.createdAt)))
    const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
    const prev = prevSteps.find((p) => p.partId === s.partId && p.seq < s.seq)
    const verb = s.mode === 'EXTERNAL_OUTSOURCE' ? '发出' : '开工'
    return {
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
    }
  })
}

/** W3：在外加工且有承诺返回日的步骤，责任人是步骤负责人 */
async function collectW3(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const steps = await prisma.routeStep.findMany({ where: { status: 'OUT', promisedReturnDate: { not: null } }, include: { part: true } })
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
    }
  })
}

// ───────────── 通知对象 ─────────────

interface NotifyContext {
  roles: NotifyRole[]
  deptOf: Map<string, string>
  pmOf: Map<string, string | null>
}

async function loadNotifyContext(targets: Target[]): Promise<NotifyContext> {
  const ownerIds = [...new Set(targets.flatMap((x) => x.ownerIds))]
  const wos = [...new Set(targets.map((x) => x.workOrderNumber).filter((w): w is string => !!w))]
  const [roles, users, exts] = await Promise.all([
    prisma.notifyRole.findMany(),
    ownerIds.length ? prisma.qmsUser.findMany({ where: { id: { in: ownerIds } }, select: { id: true, department: true } }) : [],
    wos.length ? prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } } }) : [],
  ])
  return {
    roles,
    deptOf: new Map(users.map((u) => [u.id, u.department])),
    pmOf: new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId])),
  }
}

/**
 * 升级阶梯（方案 6.2）：
 *   提醒 = 责任人；黄 = 提醒 + 责任人所在部门负责人 + 工单项目经理；红 = 黄 + 项目部负责人 + 分管领导。
 * 找不到的角色跳过，收件人去重。
 */
export function recipientsFor(level: AlertLevel, target: Pick<Target, 'ownerIds' | 'workOrderNumber'>, ctx: NotifyContext): string[] {
  const out = new Set(target.ownerIds)
  if (level === 'YELLOW' || level === 'RED') {
    const depts = new Set(target.ownerIds.map((id) => ctx.deptOf.get(id)).filter(Boolean))
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
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'

const LOCK_NAME = 'scan-rules'
/** 租约时长：远大于一轮扫描的耗时；进程崩溃后最多这么久自动失效 */
const LEASE_MS = 10 * 60_000

/** 抢租约：lockedUntil 已过期才能抢到（条件更新，天然互斥）。用真实时间，不用注入的 now */
async function acquireLease(holder: string): Promise<boolean> {
  const real = new Date()
  await prisma.jobLock.createMany({ data: [{ name: LOCK_NAME, lockedUntil: new Date(0) }], skipDuplicates: true })
  const r = await prisma.jobLock.updateMany({
    where: { name: LOCK_NAME, lockedUntil: { lt: real } },
    data: { lockedUntil: new Date(real.getTime() + LEASE_MS), holder },
  })
  return r.count === 1
}

async function releaseLease(holder: string) {
  await prisma.jobLock.updateMany({ where: { name: LOCK_NAME, holder }, data: { lockedUntil: new Date(), holder: null } })
}

/**
 * 跑一轮扫描。now 可注入（测试、演示"快进时钟"）。
 * 防重叠：job_lock 表上的租约锁，抢不到直接返回 skipped。
 */
export async function scanRules(now = new Date()): Promise<ScanResult> {
  const holder = randomUUID()
  if (!(await acquireLease(holder))) return { skipped: true, created: 0, escalated: 0, cleared: 0, reminders: 0, active: 0 }
  try {
    return await runScan(now)
  } finally {
    await releaseLease(holder)
  }
}

async function runScan(now: Date): Promise<ScanResult> {
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const targets = await collectTargets(now, thresholds, offDays)
  const activeAlerts = await prisma.alert.findMany({ where: { status: 'ACTIVE', rule: { in: SCAN_RULES } } })
  const byKey = new Map(activeAlerts.map((a) => [a.activeKey!, a]))
  const ctx = await loadNotifyContext(targets)
  const result: ScanResult = { skipped: false, created: 0, escalated: 0, cleared: 0, reminders: 0, active: 0 }

  for (const target of targets) {
    let alert: Alert | null = byKey.get(target.key) ?? null
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
    } else {
      // 只升不降：阈值调大或计时变短都不退级
      const next = maxLevel(alert.level, target.level)!
      if (isHigher(next, alert.level)) {
        alert = await prisma.alert.update({ where: { id: alert.id }, data: { level: next, levelAt: now } })
        result.escalated++
      }
    }
    result.active++

    // 当前级别该收到的人补齐（已有的跳过）
    const users = recipientsFor(alert.level, target, ctx)
    if (!users.length) continue
    const title = reminderTitle(alert.level, target.subject, target.summary, target.workOrderNumber)
    const { count } = await prisma.reminder.createMany({
      data: users.map((userId) => ({ userId, alertId: alert!.id, level: alert!.level, title })),
      skipDuplicates: true,
    })
    if (count) {
      result.reminders += count
      await prisma.alert.update({ where: { id: alert.id }, data: { lastNotifiedAt: new Date() } })
    }
  }

  // 对象已离开规则关注的状态（已处理、已发出/开工、已返厂）→ 消除
  const live = new Set(targets.map((x) => x.key))
  const gone = activeAlerts.filter((a) => !live.has(a.activeKey!)).map((a) => a.id)
  if (gone.length) {
    const { count } = await prisma.alert.updateMany({ where: { id: { in: gone }, status: 'ACTIVE' }, data: { status: 'CLEARED', activeKey: null } })
    result.cleared = count
  }
  return result
}
