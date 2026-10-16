/** 我的提醒：列表（附跳转地址）、标记已读、新提醒轮询；预警列表。 */
import type { AlertLevel, AlertRule } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { durationText, elapsedExcludingOffDays } from './rules'
import { SCAN_RULES, collectTargets, loadOffDays, loadThresholds } from './scan'

interface Link {
  /** 电脑端：步骤 → 工件页对应工单；待确认 → 待确认匹配页 */
  pc: string | null
  /** 手机端：W2 厂外步骤 → 发出登记；在外步骤 → 外协在途；待确认没有手机页面 */
  mobile: string | null
}

async function linksFor(alertIds: string[]): Promise<Map<string, Link & { rule: AlertRule; cleared: boolean }>> {
  const alerts = alertIds.length ? await prisma.alert.findMany({ where: { id: { in: alertIds } } }) : []
  const stepIds = alerts.filter((a) => a.refType === 'step').map((a) => a.refId)
  const steps = stepIds.length ? await prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: { select: { workOrderNumber: true } } } }) : []
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const out = new Map<string, Link & { rule: AlertRule; cleared: boolean }>()
  for (const a of alerts) {
    let link: Link = { pc: null, mobile: null }
    if (a.refType === 'unmatched') link = { pc: '/unmatched', mobile: null }
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
              : null,
      }
    }
    out.set(a.id, { ...link, rule: a.rule, cleared: a.status !== 'ACTIVE' })
  }
  return out
}

const SELECT = { id: true, title: true, level: true, readAt: true, createdAt: true, alertId: true } as const

export async function listReminders(userId: string) {
  const [items, unread] = await Promise.all([
    prisma.reminder.findMany({
      where: { userId },
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 100,
      select: SELECT,
    }),
    prisma.reminder.count({ where: { userId, readAt: null } }),
  ])
  const links = await linksFor([...new Set(items.map((i) => i.alertId).filter((x): x is string => !!x))])
  return {
    items: items.map((i) => {
      const l = i.alertId ? links.get(i.alertId) : undefined
      return { ...i, rule: l?.rule ?? null, cleared: l?.cleared ?? false, link: l?.pc ?? null, mobileLink: l?.mobile ?? null }
    }),
    unread,
  }
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
 * 电脑端右上角弹出用：since 之后新建的、未读的黄色和红色提醒。
 * 不带 since 时以当前时间为起点：页面第一次调用拿到的只用来记住"已经见过"，不弹出（第一次进页面不弹旧提醒）。
 */
export async function newReminders(userId: string, since: Date | null) {
  const now = new Date()
  since ??= now
  const items = await prisma.reminder.findMany({
    where: { userId, readAt: null, level: { in: ['YELLOW', 'RED'] }, createdAt: { gte: new Date(+since - OVERLAP_MS) } },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: SELECT,
  })
  const links = await linksFor([...new Set(items.map((i) => i.alertId).filter((x): x is string => !!x))])
  return { now, items: items.map((i) => ({ ...i, link: (i.alertId && links.get(i.alertId)?.pc) || null })) }
}

// ───────────── 预警列表 ─────────────

export interface AlertFilter {
  rule?: AlertRule
  level?: AlertLevel
  workOrderNumber?: string
}

/** 活动中的预警，附对象、情况、已持续时长、责任人 */
export async function listAlerts(filter: AlertFilter, now = new Date()) {
  const alerts = await prisma.alert.findMany({
    where: { status: 'ACTIVE', rule: filter.rule ?? { in: SCAN_RULES }, ...(filter.level ? { level: filter.level } : {}) },
    orderBy: [{ levelAt: 'desc' }],
  })
  if (!alerts.length) return []
  // 演示"快进时钟"扫描后 levelAt 会晚于当前时间，此时按 levelAt 算，免得显示的时长比级别还短
  const at = new Date(Math.max(+now, ...alerts.map((a) => +a.levelAt)))
  const [thresholds, offDays] = await Promise.all([loadThresholds(), loadOffDays()])
  const targets = new Map((await collectTargets(at, thresholds, offDays)).map((t) => [t.key, t]))
  const names = await loadNames({ user: [...targets.values()].flatMap((t) => t.ownerIds) })
  const rank = { RED: 0, YELLOW: 1, REMIND: 2 } as const
  return alerts
    .map((a) => {
      const t = targets.get(a.activeKey!)
      // 对象状态刚变、下一轮扫描才消除的，不再列出
      if (!t) return null
      if (filter.workOrderNumber && t.workOrderNumber !== filter.workOrderNumber) return null
      return {
        id: a.id,
        rule: a.rule,
        level: a.level,
        refType: a.refType,
        refId: a.refId,
        workOrderNumber: t.workOrderNumber,
        subject: t.subject,
        summary: t.summary,
        startAt: t.startAt,
        duration: a.rule === 'W3' ? null : durationText(elapsedExcludingOffDays(t.startAt, at, offDays)),
        owners: t.ownerIds.map((id) => ({ id, name: names.user.get(id) ?? id })),
        firstAt: a.firstAt,
        levelAt: a.levelAt,
        link: t.refType === 'unmatched' ? '/unmatched' : t.workOrderNumber ? `/parts?wo=${encodeURIComponent(t.workOrderNumber)}` : null,
      }
    })
    .filter((x) => x !== null)
    .sort((x, y) => rank[x.level] - rank[y.level] || +y.levelAt - +x.levelAt)
}
