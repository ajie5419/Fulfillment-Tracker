import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { DIRECTORY_PAGE_SIZE } from '../../shared/board-directory'
import type { RoleContext } from '../../server/services/auth/permissions'

const url = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
describe.skipIf(!url)('项目总览目录', () => {
  const prefix = 'T-BOARD-DIR-'
  const nos = Array.from({ length: 113 }, (_, i) => prefix + String(i).padStart(3, '0'))
  const now = new Date('2040-05-01T12:00:00Z')
  const scope = nos.slice(0, -1)
  const ctx: RoleContext = { userId: 'directory-pm', isAdmin: false, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set([nos[109]!, nos[112]!]) }
  const options = { page: 1, pageSize: DIRECTORY_PAGE_SIZE, q: '', delivery: 'all', mine: '0' } as const
  let db: PrismaClient
  let directory: typeof import('../../server/services/plan/list').listBoardDirectory
  const where = { workOrderNumber: { in: nos } }
  async function clean() {
    await db.planNode.deleteMany({ where })
    await db.workOrderPlan.deleteMany({ where })
    await db.qmsWorkOrder.deleteMany({ where })
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    db = (await import('../../server/utils/prisma')).prisma
    directory = (await import('../../server/services/plan/list')).listBoardDirectory
    await clean()
    await db.qmsWorkOrder.createMany({ data: nos.map((workOrderNumber, i) => ({
      workOrderNumber, customerName: i >= 100 ? '目标客户' : '普通客户', projectName: '目录验证 ' + i,
      quantity: 1, deliveryDate: new Date(i === 109 ? '2040-05-15' : '2040-05-16'), status: i === 110 ? 'COMPLETED' : 'IN_PROGRESS', isDeleted: i === 111, updatedAt: now,
    })) })
    for (const i of [0, 107, 108]) {
      const workOrderNumber = nos[i]!
      await db.workOrderPlan.create({ data: { workOrderNumber, status: i === 0 ? 'DRAFT' : 'PUBLISHED' } })
      await db.planNode.create({ data: { workOrderNumber, seq: 1, name: '发运', dept: 'PROJECT', planDate: new Date('2040-05-22') } })
    }
  })
  afterAll(async () => { if (db) { await clean(); await db.$disconnect() } })
  it('分页不漏单并在服务端组合搜索、交期和负责人范围', async () => {
    const first = await directory(scope, ctx, options, now)
    const last = await directory(scope, ctx, { ...options, page: 10 }, now)
    expect(first.total).toBe(110)
    expect(first.rows).toHaveLength(DIRECTORY_PAGE_SIZE)
    expect(last.rows).toHaveLength(2)
    const mine = await directory(scope, ctx, { ...options, delivery: 'soon', q: '目标客户', mine: '1' }, now)
    expect(mine.rows.map(r => r.workOrderNumber)).toEqual([nos[109]])
    expect(mine.rows[0]?.dueSoon).toBe(true)
    expect(mine.available).toBe(110)
    expect((await directory([], ctx, options, now)).available).toBe(0)
  })
  it('先对完整范围判断预计拖期，再分页；草稿不参与', async () => {
    const result = await directory(scope, ctx, { ...options, delivery: 'late', pageSize: 1, page: 2 }, now)
    expect(result.total).toBe(2)
    expect(result.rows.map(r => r.workOrderNumber)).toEqual([nos[108]])
    expect(result.rows[0]?.delayDays).toBe(6)
  })
})
