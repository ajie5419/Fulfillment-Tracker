/**
 * 已完工 / 已取消的 QMS 工单（zhao 10-22 定"默认隐藏，可开关查看"）：真实 MySQL 上调服务层。
 * 覆盖：项目总览默认不列、withClosed 时列出但不进汇总；设置页工单列表不列；
 * 进度类预警（W6）不再报、已有的自动消除；W4 异常照常报。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL

describe.skipIf(!DB)('已完工 / 已取消的工单', () => {
  let db: PrismaClient
  let board: typeof import('../../server/services/issues/board')
  let scan: typeof import('../../server/services/alerts/scan')
  let settings: typeof import('../../server/services/alerts/settings')
  const NOW = new Date('2026-10-22T04:00:00.000Z')
  const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.issueLog.deleteMany()
    await db.issue.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.qmsWorkOrder.deleteMany()
  }

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    board = await import('../../server/services/issues/board')
    scan = await import('../../server/services/alerts/scan')
    settings = await import('../../server/services/alerts/settings')
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const wo = (no: string, status: string) => ({ workOrderNumber: no, customerName: `客户${no}`, quantity: 1, deliveryDate: D('2026-10-01'), status, updatedAt: NOW })
    await db.qmsWorkOrder.createMany({
      data: [wo('X-OPEN', 'OPEN'), wo('X-DOING', 'IN_PROGRESS'), wo('X-DONE', 'COMPLETED'), wo('X-CANCEL', 'CANCELLED'), wo('X-OTHER', 'PAUSED')],
    })
    // 需求日已过、未到货的物料 → W6 红
    await db.purchaseLine.createMany({
      data: ['X-DOING', 'X-DONE'].map((w) => ({ workOrderNumber: w, materialName: `钢板${w}`, quantity: 1, needDate: D('2026-10-10') })),
    })
    // 很早以前提的、还没受理的异常 → W4
    await db.issue.createMany({
      data: ['X-DOING', 'X-DONE'].map((w, i) => ({ issueNo: `YC-X-${i}`, workOrderNumber: w, category: 'OTHER' as const, description: '测试', source: 'MANUAL' as const, createdAt: D('2026-10-01') })),
    })
  })

  afterAll(async () => {
    if (db) await clean()
  })

  it('项目总览默认只列在做的工单（QMS 别的状态值照样列）', async () => {
    const b = await board.getBoard(undefined, NOW)
    expect(b.rows.map((r) => r.workOrderNumber).sort()).toEqual(['X-DOING', 'X-OPEN', 'X-OTHER'])
    expect(b.rows.every((r) => !r.closed)).toBe(true)
  })

  it('打开"显示已完工"：列出已完工 / 已取消（closed = true），但不进汇总', async () => {
    const b = await board.getBoard(undefined, NOW, { withClosed: true })
    expect(b.rows.filter((r) => r.closed).map((r) => r.workOrderNumber).sort()).toEqual(['X-CANCEL', 'X-DONE'])
    const def = await board.getBoard(undefined, NOW)
    expect(b.summary).toEqual(def.summary)
    expect(b.sourceByDept).toEqual(def.sourceByDept)
  })

  it('设置页工单列表（指定项目经理）不列已关闭的', async () => {
    const s = await settings.getSettings()
    expect(s.workOrders.map((w) => w.workOrderNumber).sort()).toEqual(['X-DOING', 'X-OPEN', 'X-OTHER'])
  })

  it('进度类预警（W6）不报已完工工单，W4 异常照常报', async () => {
    const t = await scan.loadThresholds()
    const w6 = await scan.collectTargets(NOW, t, [], 'W6')
    expect(w6.map((x) => x.workOrderNumber)).toEqual(['X-DOING'])
    const w4 = await scan.collectTargets(NOW, t, [], 'W4')
    expect(w4.map((x) => x.workOrderNumber).sort()).toEqual(['X-DOING', 'X-DONE'])
  })

  it('工单在 QMS 里完工后，已有的进度类预警下一轮自动消除', async () => {
    await db.qmsWorkOrder.update({ where: { workOrderNumber: 'X-DONE' }, data: { status: 'IN_PROGRESS' } })
    await scan.scanRules(NOW)
    const line = await db.purchaseLine.findFirstOrThrow({ where: { workOrderNumber: 'X-DONE' } })
    const active = () => db.alert.findFirst({ where: { rule: 'W6', refId: line.id, activeKey: { not: null } } })
    expect(await active()).not.toBeNull()
    await db.qmsWorkOrder.update({ where: { workOrderNumber: 'X-DONE' }, data: { status: 'COMPLETED' } })
    await scan.scanRules(NOW)
    expect(await active()).toBeNull()
  })
})
