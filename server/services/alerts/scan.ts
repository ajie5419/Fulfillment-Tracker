/**
 * scan-rules：一次跑完 W1–W11，新建、升级、消除预警（工单已完工 / 已取消时只保留 W1、W4，见 collectTargets），并给升级阶梯上的人写"我的提醒"（方案 6.2）。
 *
 * 幂等：同一对象同一规则只有一条活动预警（alert.activeKey 唯一）；同一人同一预警同一级别只有一条提醒
 * （reminder 上 alertId+level+userId 唯一）。每轮都会把当前级别该收到的人补齐，所以中途失败下一轮自动补上。
 * 整个扫描用 job_lock 租约锁防重叠，拿不到锁直接返回。
 *
 * 红色自动转异常（W1–W3）：升到红色、通知照常发出后，在同一事务里生成异常（来源"预警转入"），预警改为"已转异常"。
 * 已转异常的预警保留 activeKey（同一对象不会马上又生成一条新预警），不再升级、不再通知；
 * 对象离开规则关注的状态时只把 activeKey 置空，状态保持"已转异常"。
 */
import type { Alert } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { convertAlertInTx } from '../issues/convert'
import { issueTransaction } from '../issues/issues'
import { withLease } from '../jobs/lease'
import { SCAN_RULES, loadOffDays, loadThresholds } from './config'
import { CONVERTIBLE_RULES, isHigher, maxLevel, reminderTitle } from './rules'
import type { ScanResult } from './types'
import { collectTargets } from './targets'
import { loadNotifyContext, recipientsFor } from './notifications'

export { SCAN_RULES, loadOffDays, loadThresholds } from './config'
export type { Target, ScanResult } from './types'
export { collectTargets } from './targets'
export { loadNotifyContext, recipientsFor } from './notifications'

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

  // 对象已离开规则关注的状态（W11 还包括状态计时周期变化或低于红线）→ 活动的消除；已转异常的只释放 activeKey
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
