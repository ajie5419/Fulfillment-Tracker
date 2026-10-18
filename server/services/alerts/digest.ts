/**
 * 每日汇总（方案 6.3）：每天早上给部门负责人、项目部负责人、分管领导、各工单项目经理在"我的提醒"顶部生成一条，
 * 内容是其可见范围内红/黄活动预警数量 + 未关闭异常数量（+ 有人未签收的发放单份数，R9；+ 缺料项数，R10；+ 出图逾期数，R11；+ 临近需求日仍未齐套的装配节点数，R12；有才显示）+ 前 5 项（红优先）。
 *
 * 不依赖服务器时区：15 分钟一轮的定时任务里判断"工厂时区 ≥ 07:30 且今天还没生成"才生成；
 * 错过了（服务停了）下一轮自动补发。幂等靠 reminder.dedupeKey（"DIGEST:<日期>:<用户>"）唯一，同人同日只有一条。
 */
import type { AlertLevel } from '@prisma/client'
import { resolveScope } from '../../utils/auth'
import { prisma } from '../../utils/prisma'
import { CATEGORY_TEXT, OPEN_STATUSES, STATUS_TEXT } from '../issues/constants'
import { loadOffDays, loadThresholds } from './config'
import { overdueWhere } from '../drawings/drawings'
import { dueWindowWhere, incompleteWhere } from '../kitting/kitting'
import { todayDate } from '../purchases/constants'
import { DAY_MS, HOUR_MS, judgeW4, reminderTitle, shanghaiDay } from './rules'
import { collectTargets } from './scan'

/** 工厂时区每天几点后生成（分钟） */
export const DIGEST_AT_MINUTES = 7 * 60 + 30
const TOP_N = 5

/** 工厂时区当前是否已到 07:30 */
export function digestDue(now: Date): boolean {
  const minutes = Math.floor((((+now + 8 * HOUR_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000)
  return minutes >= DIGEST_AT_MINUTES
}

export const digestKey = (day: string, userId: string) => `DIGEST:${day}:${userId}`

export interface DigestResult {
  day: string
  /** 还没到 07:30（force 时不看时间） */
  notYet: boolean
  recipients: number
  created: number
}

/**
 * 生成当天的汇总。force = 不看时间（演示工具"立即生成今日汇总"）；adminIds 用于算可见范围（管理员看全部）。
 */
export async function generateDailyDigest(opts: { now?: Date; force?: boolean; adminIds?: string[] } = {}): Promise<DigestResult> {
  const now = opts.now ?? new Date()
  const day = shanghaiDay(now)
  if (!opts.force && !digestDue(now)) return { day, notYet: true, recipients: 0, created: 0 }

  const [roles, pms] = await Promise.all([
    prisma.notifyRole.findMany({ where: { role: { in: ['DEPT_HEAD', 'PROJECT_DEPT_HEAD', 'LEADER'] } }, select: { userId: true } }),
    prisma.workOrderExt.findMany({ where: { projectManagerId: { not: null } }, select: { projectManagerId: true } }),
  ])
  const recipients = [...new Set([...roles.map((r) => r.userId), ...pms.map((p) => p.projectManagerId!)])]
  if (!recipients.length) return { day, notYet: false, recipients: 0, created: 0 }
  const done = new Set(
    (await prisma.reminder.findMany({ where: { dedupeKey: { in: recipients.map((u) => digestKey(day, u)) } }, select: { userId: true } })).map((r) => r.userId),
  )
  const todo = recipients.filter((u) => !done.has(u))
  if (!todo.length) return { day, notYet: false, recipients: recipients.length, created: 0 }

  // 全部活动的红黄预警（带对象文字和工单）与未关闭异常，按人过滤
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const [alerts, targets, issues, unsigned, shortage, drawingOverdue, incompleteNodes] = await Promise.all([
    // 含已转异常、但对象仍停在原状态的（activeKey 还在）
    prisma.alert.findMany({ where: { activeKey: { not: null }, status: { in: ['ACTIVE', 'CONVERTED'] }, level: { in: ['RED', 'YELLOW'] } }, orderBy: { levelAt: 'desc' } }),
    collectTargets(now, thresholds, offDays),
    prisma.issue.findMany({ where: { status: { in: OPEN_STATUSES } }, orderBy: { createdAt: 'asc' } }),
    prisma.release.findMany({ where: { status: 'ACTIVE', receipts: { some: { status: 'PENDING' } } }, select: { workOrderNumber: true } }),
    // 缺料：未到货且已到需求日的关键物料（只算 QMS 里还在的工单）
    prisma.purchaseLine.groupBy({ by: ['workOrderNumber'], where: { status: 'OPEN', needDate: { lte: todayDate(now) } }, _count: { _all: true } }),
    // 出图逾期（R11）：待出图已过计划完成日，或客户确认已过计划日
    prisma.drawingTask.groupBy({ by: ['workOrderNumber'], where: overdueWhere(todayDate(now)), _count: { _all: true } }),
    // 未齐套节点（R12）：已进入 W8 预警窗口（需求日前 N 天内，含已过）仍未齐套，与看板同一口径
    prisma.assemblyNode.groupBy({ by: ['workOrderNumber'], where: { AND: [incompleteWhere(), dueWindowWhere(now, thresholds.W8)] }, _count: { _all: true } }),
  ])
  const countedWos = [...new Set([...shortage, ...drawingOverdue, ...incompleteNodes].map((s) => s.workOrderNumber))]
  const liveWos = new Set(
    countedWos.length
      ? (await prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: countedWos } }, select: { workOrderNumber: true, isDeleted: true } })).filter((w) => !w.isDeleted).map((w) => w.workOrderNumber)
      : [],
  )
  const targetByKey = new Map(targets.map((t) => [t.key, t]))
  const alertRows = alerts
    .map((a) => ({ a, t: targetByKey.get(a.activeKey!) }))
    .filter((x): x is { a: (typeof alerts)[number]; t: NonNullable<typeof x.t> } => !!x.t)
    .sort((x, y) => (x.a.level === y.a.level ? 0 : x.a.level === 'RED' ? -1 : 1))
  const issueRows = issues
    .map((i) => ({ i, overdue: !!judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, thresholds.W4).level }))
    .sort((x, y) => Number(y.overdue) - Number(x.overdue))

  const mmdd = day.slice(5)
  const data = []
  for (const userId of todo) {
    const scope = await resolveScope(userId, opts.adminIds?.includes(userId) ?? false)
    const visible = (wo: string | null) => scope.all || (!!wo && scope.workOrders.has(wo))
    const mine = alertRows.filter((x) => visible(x.t.workOrderNumber))
    const myIssues = issueRows.filter((x) => visible(x.i.workOrderNumber))
    const red = mine.filter((x) => x.a.level === 'RED').length
    const yellow = mine.length - red
    const unsignedCount = unsigned.filter((r) => visible(r.workOrderNumber)).length
    const countIn = (gs: { workOrderNumber: string; _count: { _all: number } }[]) => gs.filter((s) => liveWos.has(s.workOrderNumber) && visible(s.workOrderNumber)).reduce((n, s) => n + s._count._all, 0)
    const shortageCount = countIn(shortage)
    const drawingCount = countIn(drawingOverdue)
    const nodeCount = countIn(incompleteNodes)
    const lines = [
      ...mine.map((x) => reminderTitle(x.a.level, x.t.subject, x.t.summary, x.t.workOrderNumber)),
      ...myIssues.map((x) => `${x.overdue ? '【超期】' : ''}异常 ${x.i.issueNo}（${CATEGORY_TEXT[x.i.category]}，${STATUS_TEXT[x.i.status]}）：${x.i.description.slice(0, 40)}（${x.i.workOrderNumber}）`),
    ].slice(0, TOP_N)
    const level: AlertLevel = red ? 'RED' : yellow ? 'YELLOW' : 'REMIND'
    data.push({
      userId,
      kind: 'DIGEST',
      level,
      dedupeKey: digestKey(day, userId),
      title: `【每日汇总】${mmdd}：红色预警 ${red} 条、黄色预警 ${yellow} 条，未关闭异常 ${myIssues.length} 条${unsignedCount ? `，未签收发放 ${unsignedCount} 份` : ''}${shortageCount ? `，缺料 ${shortageCount} 项` : ''}${drawingCount ? `，出图逾期 ${drawingCount} 项` : ''}${nodeCount ? `，未齐套节点 ${nodeCount} 个` : ''}`,
      body: lines.length ? lines.join('\n') : '今天没有红黄预警和未关闭异常',
    })
  }
  const { count } = await prisma.reminder.createMany({ data, skipDuplicates: true })
  // 旧汇总自动标为已读：未读数里只留当天这一条
  await prisma.reminder.updateMany({
    where: { userId: { in: todo }, kind: 'DIGEST', readAt: null, NOT: { dedupeKey: { startsWith: `DIGEST:${day}:` } } },
    data: { readAt: new Date() },
  })
  return { day, notYet: false, recipients: recipients.length, created: count }
}
