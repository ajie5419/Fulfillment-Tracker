/**
 * 项目日历（zhao 10-21）：真实 MySQL 上调服务层，固定 now = 2026-10-21（周三）。
 * 覆盖：已发布总计划按最后一个节点（发运）算计划 / 实际 / 逾期台数；草稿、没有总计划按 QMS 交期计入"未排总计划"；
 * 取消、删除的工单不算；QMS 已完工的：有总计划按已完成算（不判逾期），没有总计划的不进日历；工作台卡片的本周 / 下周 / 本月。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL

describe.skipIf(!DB)('项目日历', () => {
  let db: PrismaClient
  let cal: typeof import('../../server/services/calendar/calendar')
  let plan: typeof import('../../server/services/plan/plan')
  const NOW = new Date('2026-10-21T04:00:00.000Z')
  const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.todo.deleteMany()
    await db.planChangeLog.deleteMany()
    await db.planNode.deleteMany()
    await db.workOrderPlan.deleteMany()
    await db.qmsWorkOrder.deleteMany()
  }

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    cal = await import('../../server/services/calendar/calendar')
    plan = await import('../../server/services/plan/plan')
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const wo = (no: string, quantity: number, delivery: string, extra: { status?: string; isDeleted?: boolean } = {}) => ({
      workOrderNumber: no,
      customerName: `客户${no}`,
      projectName: `项目${no}`,
      quantity,
      deliveryDate: D(delivery),
      status: extra.status ?? 'IN_PROGRESS',
      isDeleted: extra.isDeleted ?? false,
      updatedAt: NOW,
    })
    await db.qmsWorkOrder.createMany({
      data: [
        wo('C-A', 2, '2026-10-22'), // 已发布：发运 10-20 没完成 → 逾期
        wo('C-B', 3, '2026-10-30'), // 已发布：发运计划 10-28，10-15 提前完成
        wo('C-C', 1, '2026-10-30'), // 草稿 → 按 QMS 交期
        wo('C-D', 5, '2026-11-10'), // 没有总计划 → 按 QMS 交期，11 月
        wo('C-E', 4, '2026-10-25', { status: 'CANCELLED' }),
        wo('C-F', 4, '2026-10-25', { isDeleted: true }),
        wo('C-G', 6, '2026-12-20', { status: 'COMPLETED' }), // 已发布：发运 12-10 没点完成，但 QMS 已完工 → 已完成
        wo('C-H', 7, '2026-12-15', { status: 'COMPLETED' }), // 没有总计划、QMS 已完工 → 不进日历
      ],
    })
    await db.workOrderPlan.createMany({
      data: [
        { workOrderNumber: 'C-A', status: 'PUBLISHED', publishedAt: NOW },
        { workOrderNumber: 'C-B', status: 'PUBLISHED', publishedAt: NOW },
        { workOrderNumber: 'C-C', status: 'DRAFT' },
        { workOrderNumber: 'C-G', status: 'PUBLISHED', publishedAt: NOW },
      ],
    })
    const node = (id: string, workOrderNumber: string, seq: number, name: string, dept: 'TECH' | 'PROJECT', planDate: string) => ({ id, workOrderNumber, seq, name, dept, planDate: D(planDate), baselineDate: D(planDate) })
    await db.planNode.createMany({
      data: [
        node('n-a1', 'C-A', 1, '设计出图', 'TECH', '2026-10-05'),
        node('n-a2', 'C-A', 2, '发运', 'PROJECT', '2026-10-20'),
        node('n-b1', 'C-B', 1, '发运', 'PROJECT', '2026-10-28'),
        node('n-c1', 'C-C', 1, '发运', 'PROJECT', '2026-10-29'),
        node('n-g1', 'C-G', 1, '发运', 'PROJECT', '2026-12-10'),
      ],
    })
    await plan.completeNode('n-a1', D('2026-10-04'), 'u-test', NOW)
    await plan.completeNode('n-b1', D('2026-10-15'), 'u-test', NOW)
  })

  afterAll(async () => {
    if (db) await clean()
  })

  it('月视图：计划 / 实际 / 逾期 / 未排总计划台数', async () => {
    const r = await cal.getCalendar('month', '2026-10-09', NOW)
    expect(r.period).toMatchObject({ start: '2026-10-01', end: '2026-10-31' })
    expect(r.summary.planned).toEqual({ orders: 3, units: 6 }) // A 2 + B 3 + C 1（草稿按交期）
    expect(r.summary.actual).toEqual({ orders: 1, units: 3 }) // B
    expect(r.summary.overdue).toEqual({ orders: 1, units: 2 }) // A
    expect(r.summary.noPlan).toEqual({ orders: 1, units: 1 }) // C
    expect(r.completions.map((c) => [c.workOrderNumber, c.state])).toEqual([
      ['C-A', 'OVERDUE'],
      ['C-B', 'DONE'],
      ['C-C', 'NO_PLAN'],
    ])
    expect(r.completions.find((c) => c.workOrderNumber === 'C-C')!.planDay).toBe('2026-10-30') // 草稿不用节点日，用 QMS 交期
    expect(r.trend).toHaveLength(6)
    expect(r.trend[2]!.period.start).toBe('2026-10-01')
    expect(r.trend[3]!.summary.planned).toEqual({ orders: 1, units: 5 }) // 11 月：D
  })

  it('月视图的工单含首尾跨月的整周（列表按整周分组），统计仍只算本月', async () => {
    const r = await cal.getCalendar('month', '2026-11-05', NOW)
    expect(r.period).toMatchObject({ start: '2026-11-01', end: '2026-11-30' })
    // 11 月第一周是 10-26 ~ 11-01：B（计划 10-28）、C（交期 10-30）也带上
    expect(r.completions.map((c) => c.workOrderNumber)).toEqual(['C-B', 'C-C', 'C-D'])
    expect(r.summary.planned).toEqual({ orders: 1, units: 5 }) // 只算 11 月的 D
  })

  it('周视图：按周一到周日', async () => {
    const r = await cal.getCalendar('week', null, NOW)
    expect(r.period).toMatchObject({ start: '2026-10-19', end: '2026-10-25' })
    expect(r.summary.planned).toEqual({ orders: 1, units: 2 })
    // B 计划在下周、实际在 10-15（第 42 周），本周两头都不沾
    expect(r.completions.map((c) => c.workOrderNumber)).toEqual(['C-A'])
  })

  it('QMS 已完工：有总计划按已完成算（没有落库完成日，不计实际台数），没有总计划的不进日历', async () => {
    const r = await cal.getCalendar('month', '2026-12-01', NOW)
    expect(r.completions.map((c) => [c.workOrderNumber, c.state])).toEqual([['C-G', 'DONE']])
    expect(r.summary.planned).toEqual({ orders: 1, units: 6 })
    expect(r.summary.actual).toEqual({ orders: 0, units: 0 })
    expect(r.summary.noPlan).toEqual({ orders: 0, units: 0 })
  })

  it('工作台卡片：本周 / 下周 / 本月', async () => {
    const r = await cal.getCalendarSummary(NOW)
    const by = Object.fromEntries(r.items.map((i) => [i.key, i.summary]))
    expect(by.thisWeek!.planned.units).toBe(2)
    expect(by.nextWeek!.planned).toEqual({ orders: 2, units: 4 }) // B 10-28、C 10-30
    expect(by.thisMonth!.actual.units).toBe(3)
  })
})
