/** 我的提醒：列表（附跳转地址）、标记已读、新提醒轮询；预警列表与手动转异常。 */
import type { AlertLevel, AlertRule } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { alertSourceKey, convertAlertInTx } from '../issues/convert'
import { issueTransaction } from '../issues/issues'
import { drawingLink, drawingMobileLink } from '../drawings/constants'
import { kittingLink, kittingMobileLink } from '../kitting/constants'
import { purchaseLink, purchaseMobileLink } from '../purchases/constants'
import { releaseLink, releaseMobileLink } from '../releases/constants'
import { isPlanNodeAlert, planLink, planNodeAlertLink } from '../plan/constants'
import { CONVERTIBLE_RULES, durationText, elapsedExcludingOffDays } from './rules'
import { SCAN_RULES, type Target, collectTargets, loadOffDays, loadThresholds } from './scan'
import { todayDay } from '../flow/dates'
import { userDeptNames } from '../auth/departments'
import { workBucket } from '../../../shared/workbench'

interface Link {
  /** 电脑端：步骤 → 工件页对应工单；待确认 → 待确认匹配页；异常 → 异常列表并打开该条；签收记录（W5）→ 发放单详情；采购行（W6）→ 采购到货页并打开该行；设计任务（W7）→ 设计任务页并打开该任务；装配节点（W8）→ 齐套页并定位该节点 */
  pc: string | null
  /** 手机端：W2 厂外步骤 → 发出登记；在外步骤 → 外协在途；加工中步骤（W10）→ 手机加工中页；异常 → 我的异常；签收记录 → 手机签收页；采购行 → 到货确认页；设计任务 → 我的设计任务；装配节点 → 手机齐套页；待确认没有手机页面 */
  mobile: string | null
}

interface LinkInfo extends Link {
  /** 所属工单（工作台卡片用）；对象删了或不属于某个工单为 null */
  workOrderNumber: string | null
  /** 对象的截止日 'YYYY-MM-DD'（工作台按它分组）：设计计划完成日（设计完成等客户确认时为客户确认计划日）、物料需求日、装配节点需求日、
   *  总计划节点计划日、异常要求解决日、外协承诺返回日 / 工序要求完成日；节点超时未确认、发放签收等没有截止日的为 null */
  dueDay: string | null
  rule: AlertRule
  /** 预警已消除（对象状态已变化） */
  cleared: boolean
  /** 已转为异常时的异常编号 */
  issueNo: string | null
}

const issueLink = (id: string): Link => ({ pc: `/issues?id=${encodeURIComponent(id)}`, mobile: `/m/issues?id=${encodeURIComponent(id)}` })

async function linksFor(alertIds: string[]): Promise<Map<string, LinkInfo>> {
  const alerts = alertIds.length ? await prisma.alert.findMany({ where: { id: { in: alertIds } } }) : []
  const stepIds = alerts.filter((a) => a.refType === 'step').map((a) => a.refId)
  const receiptIds = alerts.filter((a) => a.refType === 'receipt').map((a) => a.refId)
  const planNodeIds = alerts.filter((a) => isPlanNodeAlert(a.refType)).map((a) => a.refId)
  const converted = alerts.filter((a) => a.status === 'CONVERTED').map((a) => alertSourceKey(a.id))
  const idsOf = (refType: string) => alerts.filter((a) => a.refType === refType).map((a) => a.refId)
  const [purchaseIds, drawingIds, nodeIds, issueIds, releaseIds] = ['purchase', 'drawing', 'node', 'issue', 'release'].map(idsOf) as [string[], string[], string[], string[], string[]]
  const [steps, issues, receipts, planNodes, purchases, drawings, nodes, refIssues, releases] = await Promise.all([
    stepIds.length ? prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: { select: { workOrderNumber: true } } } }) : [],
    converted.length ? prisma.issue.findMany({ where: { sourceKey: { in: converted } }, select: { id: true, issueNo: true, sourceKey: true } }) : [],
    receiptIds.length ? prisma.releaseReceipt.findMany({ where: { id: { in: receiptIds } }, select: { id: true, releaseId: true, release: { select: { workOrderNumber: true } } } }) : [],
    planNodeIds.length ? prisma.planNode.findMany({ where: { id: { in: planNodeIds } }, select: { id: true, workOrderNumber: true, planDate: true } }) : [],
    // 工作台卡片的所属工单、截止日（前端改版第二轮）
    purchaseIds.length ? prisma.purchaseLine.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, workOrderNumber: true, needDate: true } }) : [],
    drawingIds.length ? prisma.drawingTask.findMany({ where: { id: { in: drawingIds } }, select: { id: true, workOrderNumber: true, status: true, planDate: true, customerPlanDate: true } }) : [],
    nodeIds.length ? prisma.assemblyNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, workOrderNumber: true, needDate: true } }) : [],
    issueIds.length ? prisma.issue.findMany({ where: { id: { in: issueIds } }, select: { id: true, workOrderNumber: true, dueDate: true } }) : [],
    releaseIds.length ? prisma.release.findMany({ where: { id: { in: releaseIds } }, select: { id: true, workOrderNumber: true } }) : [],
  ])
  const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
  /** 对象 → 所属工单、截止日 */
  const facts = new Map<string, { workOrderNumber: string | null; dueDay: string | null }>()
  for (const r of purchases) facts.set(`purchase:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: day(r.needDate) })
  // 设计：设计中看计划完成日；设计完成等客户确认看客户确认计划日
  for (const r of drawings) facts.set(`drawing:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: day(r.status === 'PENDING' ? r.planDate : (r.customerPlanDate ?? r.planDate)) })
  for (const r of nodes) facts.set(`node:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: day(r.needDate) })
  for (const r of refIssues) facts.set(`issue:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: day(r.dueDate) })
  for (const r of releases) facts.set(`release:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: null })
  for (const r of receipts) facts.set(`receipt:${r.id}`, { workOrderNumber: r.release.workOrderNumber, dueDay: null })
  for (const r of planNodes) {
    facts.set(`planNode:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: day(r.planDate) })
    // 节点超时未确认：要做的是"确认"，没有截止日（归"未定截止日"），不用节点的计划日
    facts.set(`planConfirm:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: null })
    // 节点未分解：要做的是"分解"，同样没有截止日
    facts.set(`planSplit:${r.id}`, { workOrderNumber: r.workOrderNumber, dueDay: null })
  }
  for (const r of steps) facts.set(`step:${r.id}`, { workOrderNumber: r.part.workOrderNumber, dueDay: day(r.promisedReturnDate ?? r.dueDate) })
  const planWoOf = new Map(planNodes.map((n) => [n.id, n.workOrderNumber]))
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const releaseOf = new Map(receipts.map((r) => [r.id, r.releaseId]))
  const issueBySource = new Map(issues.map((i) => [i.sourceKey!, i]))
  const out = new Map<string, LinkInfo>()
  for (const a of alerts) {
    let link: Link = { pc: null, mobile: null }
    if (a.refType === 'unmatched') link = { pc: '/unmatched', mobile: null }
    if (a.refType === 'issue') link = issueLink(a.refId)
    if (a.refType === 'purchase') link = { pc: purchaseLink(a.refId), mobile: purchaseMobileLink(a.refId) }
    if (a.refType === 'drawing') link = { pc: drawingLink(a.refId), mobile: drawingMobileLink(a.refId) }
    if (a.refType === 'node') link = { pc: kittingLink(a.refId), mobile: kittingMobileLink(a.refId) }
    // 总计划（W9）只有电脑端页面；节点删了就没有跳转
    const planWo = isPlanNodeAlert(a.refType) ? planWoOf.get(a.refId) : undefined
    if (planWo) link = planNodeAlertLink(a.refType, planWo, a.refId)
    if (a.refType === 'plan') link = { pc: planLink(a.refId), mobile: null }
    const releaseId = a.refType === 'receipt' ? releaseOf.get(a.refId) : a.refType === 'release' ? a.refId : undefined
    if (releaseId) link = { pc: releaseLink(releaseId), mobile: releaseMobileLink(releaseId) }
    const step = a.refType === 'step' ? stepById.get(a.refId) : undefined
    if (step) {
      const wo = encodeURIComponent(step.part.workOrderNumber)
      link = {
        pc: `/parts?wo=${wo}`,
        mobile:
          step.status === 'PENDING' && step.mode === 'EXTERNAL_OUTSOURCE'
            ? `/m/send?stepId=${encodeURIComponent(step.id)}`
            : step.status === 'OUT'
              ? `/m/transit?wo=${wo}`
              : step.status === 'IN_PROGRESS'
                ? `/m/working?stepId=${encodeURIComponent(step.id)}`
                : null,
      }
    }
    // 已转异常：跳到生成的异常
    const issue = a.status === 'CONVERTED' ? issueBySource.get(alertSourceKey(a.id)) : undefined
    if (issue) link = issueLink(issue.id)
    const f = facts.get(`${a.refType}:${a.refId}`) ?? { workOrderNumber: a.refType === 'plan' ? a.refId : null, dueDay: null }
    out.set(a.id, { ...link, ...f, rule: a.rule, cleared: a.status === 'CLEARED', issueNo: issue?.issueNo ?? null })
  }
  return out
}

const SELECT = { id: true, title: true, level: true, readAt: true, createdAt: true, alertId: true, kind: true, body: true, link: true } as const

/** 发放单通知（kind = RELEASE，如拒收）：电脑端 link 存在提醒上，手机端换成对应的手机页 */
const mobileOf = (link: string | null) => (link?.startsWith('/releases?id=') ? `/m/release?id=${link.slice('/releases?id='.length)}` : null)

/** 同步失败提醒（管理员）：点开去设置页的"QMS 同步状态" */
const SYNC_FAIL_LINK = '/settings?tab=sync'
/** 预警/待办类提醒、发放单通知、总计划通知（R14 节点被退回）+ 已读的同步失败提醒（未读的置顶，不在分组里重复出现） */
const LISTED = { OR: [{ kind: null }, { kind: 'RELEASE' }, { kind: 'PLAN' }, { kind: 'SYNC_FAIL', readAt: { not: null } }] }

/**
 * 我的提醒。每日汇总（kind = DIGEST）单独返回最新一条作为置顶（digest），不混在分组列表里；
 * 生成新汇总时旧汇总已自动标为已读，所以未读数里最多只有当天这一条。
 * QMS 同步连续失败（kind = SYNC_FAIL，只发给管理员）未读时置顶（pinned），读过后回到红色分组里。
 */
export async function listReminders(userId: string, now = new Date()) {
  const [items, unread, digest, pinned] = await Promise.all([
    prisma.reminder.findMany({
      where: { userId, ...LISTED },
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 100,
      select: SELECT,
    }),
    prisma.reminder.count({ where: { userId, readAt: null } }),
    // dedupeKey 里带日期（DIGEST:<YYYY-MM-DD>:<用户>），同一人按它倒序就是最新一天
    prisma.reminder.findFirst({ where: { userId, kind: 'DIGEST' }, orderBy: { dedupeKey: 'desc' }, select: SELECT }),
    prisma.reminder.findMany({ where: { userId, kind: 'SYNC_FAIL', readAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: SELECT }),
  ])
  const links = await linksFor([...new Set(items.map((i) => i.alertId).filter((x): x is string => !!x))])
  const today = todayDay(now)
  /** 工作台卡片流（前端改版第二轮）：按截止日分组；预警类用对象的截止日，发放单 / 总计划通知没有截止日（归"未定截止日"） */
  const card = <T extends { level: AlertLevel; cleared: boolean; dueDay: string | null }>(r: T) => ({ ...r, bucket: workBucket({ kind: 'reminder', level: r.level, cleared: r.cleared, dueDay: r.dueDay }, today) })
  return {
    digest: digest ? { ...digest, lines: (digest.body ?? '').split('\n').filter(Boolean) } : null,
    pinned: pinned.map((p) => ({ ...p, lines: (p.body ?? '').split('\n').filter(Boolean), link: SYNC_FAIL_LINK })),
    items: items.map((i) => {
      const none = { workOrderNumber: null, dueDay: null }
      if (i.kind === 'SYNC_FAIL') return card({ ...i, ...none, rule: null, cleared: false, issueNo: null, link: SYNC_FAIL_LINK, mobileLink: null })
      if (i.kind === 'RELEASE') return card({ ...i, ...none, rule: null, cleared: false, issueNo: null, link: i.link, mobileLink: mobileOf(i.link) })
      if (i.kind === 'PLAN') return card({ ...i, ...none, workOrderNumber: planWoOfLink(i.link), rule: null, cleared: false, issueNo: null, link: i.link, mobileLink: null })
      const l = i.alertId ? links.get(i.alertId) : undefined
      return card({
        ...i,
        workOrderNumber: l?.workOrderNumber ?? null,
        dueDay: l?.dueDay ?? null,
        rule: l?.rule ?? null,
        cleared: l?.cleared ?? false,
        issueNo: l?.issueNo ?? null,
        link: l?.pc ?? null,
        mobileLink: l?.mobile ?? null,
      })
    }),
    unread,
  }
}

/** 总计划通知的跳转地址 /plan?wo=… 里取工单号 */
function planWoOfLink(link: string | null): string | null {
  if (!link?.startsWith('/plan?')) return null
  return new URLSearchParams(link.slice('/plan?'.length)).get('wo')
}

/** 未读提醒数（菜单"工作台"角标，前端改版第二轮）：与 listReminders 的 unread 同一口径（本人的、未读的，含每日汇总） */
export async function unreadCount(userId: string) {
  return { unread: await prisma.reminder.count({ where: { userId, readAt: null } }) }
}

export async function markRead(userId: string, id: string) {
  const { count } = await prisma.reminder.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } })
  if (!count && !(await prisma.reminder.findFirst({ where: { id, userId }, select: { id: true } }))) throw new FlowError('提醒不存在')
  return { ok: true }
}

export async function markAllRead(userId: string) {
  const { count } = await prisma.reminder.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })
  return { count }
}

/** 轮询重叠窗口：上一轮查询时刚好在写入的提醒不会漏掉，重复的由页面按 id 去重 */
const OVERLAP_MS = 60_000

/**
 * 电脑端右上角弹出用：since 之后新建的、未读的黄色和红色提醒，含 QMS 同步失败（每日汇总不弹）。
 * 不截断条数：截断后游标照样推进，超出的就永远弹不出来了；条数多时由页面合并显示。
 * 不带 since 时以当前时间为起点：页面第一次调用拿到的只用来记住"已经见过"，不弹出（第一次进页面不弹旧提醒）。
 */
export async function newReminders(userId: string, since: Date | null) {
  const now = new Date()
  since ??= now
  const items = await prisma.reminder.findMany({
    where: { userId, OR: [{ kind: null }, { kind: 'SYNC_FAIL' }, { kind: 'RELEASE' }, { kind: 'PLAN' }], readAt: null, level: { in: ['YELLOW', 'RED'] }, createdAt: { gte: new Date(+since - OVERLAP_MS) } },
    orderBy: { createdAt: 'asc' },
    select: SELECT,
  })
  const links = await linksFor([...new Set(items.map((i) => i.alertId).filter((x): x is string => !!x))])
  return { now, items: items.map((i) => ({ ...i, link: i.kind === 'SYNC_FAIL' ? SYNC_FAIL_LINK : i.kind === 'RELEASE' || i.kind === 'PLAN' ? i.link : (i.alertId && links.get(i.alertId)?.pc) || null })) }
}

// ───────────── 预警列表 ─────────────

export interface Viewer {
  userId: string
  isAdmin: boolean
}

export interface AlertFilter {
  rule?: AlertRule
  level?: AlertLevel
  workOrderNumber?: string
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
  /** 当前用户，用于判断能否"转异常" */
  viewer?: Viewer
}

/** 黄色预警手动转异常的权限：预警责任人、该工单项目经理、管理员 */
function canConvert(level: AlertLevel, target: Pick<Target, 'rule' | 'ownerIds'>, pm: string | null | undefined, viewer: Viewer | undefined) {
  if (!viewer || level !== 'YELLOW' || !CONVERTIBLE_RULES.includes(target.rule)) return false
  return viewer.isAdmin || target.ownerIds.includes(viewer.userId) || (!!pm && pm === viewer.userId)
}

/** 预警列表里"去处理"的电脑端地址 */
function targetLink(t: Target): string | null {
  if ((t.refType === 'receipt' || t.refType === 'release') && t.meta?.releaseId) return releaseLink(t.meta.releaseId)
  if (t.refType === 'purchase') return purchaseLink(t.refId)
  if (t.refType === 'drawing') return drawingLink(t.refId)
  if (t.refType === 'node') return kittingLink(t.refId)
  if (isPlanNodeAlert(t.refType) && t.workOrderNumber) return planNodeAlertLink(t.refType, t.workOrderNumber, t.refId).pc
  if (t.refType === 'plan') return planLink(t.refId)
  if (t.refType === 'unmatched') return '/unmatched'
  if (t.refType === 'issue') return `/issues?id=${encodeURIComponent(t.refId)}`
  return t.workOrderNumber ? `/parts?wo=${encodeURIComponent(t.workOrderNumber)}` : null
}

/** 预警列表：活动中的预警，以及已转异常但对象仍在关注状态的（显示"已转异常 YC-…"）。附对象、情况、已持续时长、责任人 */
export async function listAlerts(filter: AlertFilter, now = new Date()) {
  const alerts = await prisma.alert.findMany({
    where: {
      activeKey: { not: null },
      status: { in: ['ACTIVE', 'CONVERTED'] },
      rule: filter.rule ?? { in: SCAN_RULES },
      ...(filter.level ? { level: filter.level } : {}),
    },
    orderBy: [{ levelAt: 'desc' }],
  })
  if (!alerts.length) return []
  // 演示"快进时钟"扫描后 levelAt 会晚于当前时间，此时按 levelAt 算，免得显示的时长比级别还短
  const at = new Date(Math.max(+now, ...alerts.map((a) => +a.levelAt)))
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const targets = new Map((await collectTargets(at, thresholds, offDays, filter.rule)).map((t) => [t.key, t]))
  const wos = [...new Set([...targets.values()].map((t) => t.workOrderNumber).filter((x): x is string => !!x))]
  const [names, exts, issues, deptOf] = await Promise.all([
    loadNames({ user: [...targets.values()].flatMap((t) => t.ownerIds) }),
    wos.length ? prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, projectManagerId: true } }) : [],
    prisma.issue.findMany({
      where: { sourceKey: { in: alerts.filter((a) => a.status === 'CONVERTED').map((a) => alertSourceKey(a.id)) } },
      select: { id: true, issueNo: true, sourceKey: true },
    }),
    // 责任部门（风险页按部门汇总）：与升级阶梯同一口径，见 scan.ts recipientsFor
    userDeptNames([...targets.values()].flatMap((t) => t.ownerIds)),
  ])
  const pmOf = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  const issueBySource = new Map(issues.map((i) => [i.sourceKey!, i]))
  const visible = filter.visibleWorkOrders ? new Set(filter.visibleWorkOrders) : null
  const rank = { RED: 0, YELLOW: 1, REMIND: 2 } as const
  return alerts
    .map((a) => {
      const t = targets.get(a.activeKey!)
      // 对象状态刚变、下一轮扫描才消除的，不再列出
      if (!t) return null
      if (filter.workOrderNumber && t.workOrderNumber !== filter.workOrderNumber) return null
      if (visible && (!t.workOrderNumber || !visible.has(t.workOrderNumber))) return null
      const issue = a.status === 'CONVERTED' ? issueBySource.get(alertSourceKey(a.id)) : undefined
      return {
        id: a.id,
        rule: a.rule,
        level: a.level,
        status: a.status,
        refType: a.refType,
        refId: a.refId,
        workOrderNumber: t.workOrderNumber,
        subject: t.subject,
        summary: t.summary,
        startAt: t.startAt,
        duration:
          a.rule === 'W3' || a.rule === 'W10' || a.rule === 'W4' || a.rule === 'W6' || a.rule === 'W7' || a.rule === 'W8' || (a.rule === 'W9' && a.refType !== 'planConfirm' && a.refType !== 'planSplit')
            ? null
            : durationText(elapsedExcludingOffDays(t.startAt, at, offDays)),
        owners: t.ownerIds.map((id) => ({ id, name: names.user.get(id) ?? id })),
        /** 责任部门（业务部门名称）：规则写明的部门，没有时取责任人所在部门；风险页按部门汇总用 */
        deptNames: t.deptNames?.length ? t.deptNames : [...new Set(t.ownerIds.map((id) => deptOf.get(id)).filter((x): x is string => !!x))],
        firstAt: a.firstAt,
        levelAt: a.levelAt,
        issue: issue ? { id: issue.id, issueNo: issue.issueNo } : null,
        canConvert: a.status === 'ACTIVE' && canConvert(a.level, t, t.workOrderNumber ? pmOf.get(t.workOrderNumber) : null, filter.viewer),
        link: targetLink(t),
      }
    })
    .filter((x) => x !== null)
    .sort((x, y) => Number(x.status === 'CONVERTED') - Number(y.status === 'CONVERTED') || rank[x.level] - rank[y.level] || +y.levelAt - +x.levelAt)
}

/**
 * 黄色预警手动转异常（预警列表的"转异常"按钮）：预警责任人、该工单项目经理、管理员可点。
 * 与红色自动转共用 convertAlertInTx；锁住预警行后再确认仍是活动的黄色预警，重复点击只成功一次。
 */
export async function convertAlert(alertId: string, viewer: Viewer, visibleWorkOrders?: string[]) {
  const alert = await prisma.alert.findUnique({ where: { id: alertId } })
  if (!alert) throw new FlowError('预警不存在')
  if (alert.status === 'CONVERTED') throw new FlowError('该预警已经转为异常')
  if (alert.status !== 'ACTIVE' || !alert.activeKey) throw new FlowError('该预警已消除')
  if (!CONVERTIBLE_RULES.includes(alert.rule)) throw new FlowError('异常超期预警不能再转异常')
  if (alert.level !== 'YELLOW') throw new FlowError('只有黄色预警可以手动转异常（红色预警会自动转）')
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const at = new Date(Math.max(Date.now(), +alert.levelAt))
  const target = (await collectTargets(at, thresholds, offDays, alert.rule)).find((t) => t.key === alert.activeKey)
  if (!target) throw new FlowError('预警对象的状态已变化，请刷新')
  if (visibleWorkOrders && (!target.workOrderNumber || !visibleWorkOrders.includes(target.workOrderNumber))) throw new FlowForbidden('无权查看该工单的数据')
  const pm = target.workOrderNumber
    ? (await prisma.workOrderExt.findUnique({ where: { workOrderNumber: target.workOrderNumber }, select: { projectManagerId: true } }))?.projectManagerId
    : null
  if (!canConvert(alert.level, target, pm, viewer)) throw new FlowForbidden('只有预警责任人、该工单项目经理或管理员可以转异常')
  return issueTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM alert WHERE id = ${alertId} FOR UPDATE`
    const locked = await tx.alert.findUnique({ where: { id: alertId } })
    if (!locked || locked.status !== 'ACTIVE') throw new FlowError('预警状态已变化，请刷新')
    const issue = await convertAlertInTx(tx, locked, target, viewer.userId)
    return { issueId: issue.id, issueNo: issue.issueNo }
  })
}
