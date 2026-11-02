/** 真实 MySQL 验证四类列表：稳定排序、总数、分页后集合等于全量；本批仅编写不运行。 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const prefix = 'T-B6-PAGE-'
const now = new Date('2040-05-15T04:00:00Z')
describe.skipIf(!DB)('数据库分页一致性', () => {
  let db: PrismaClient
  let releases: typeof import('../../server/services/releases/queries')
  let issues: typeof import('../../server/services/issues/queries')
  let comments: typeof import('../../server/services/comments/comments')
  let plans: typeof import('../../server/services/plan/list')
  const visible = Array.from({ length: 9 }, (_, i) => `${prefix}${i}`)
  const actor = { userId: `${prefix}viewer`, isAdmin: true }
  async function clean() {
    await db.comment.deleteMany({ where: { workOrderNumber: { in: visible } } })
    await db.release.deleteMany({ where: { workOrderNumber: { in: visible } } })
    await db.issue.deleteMany({ where: { workOrderNumber: { in: visible } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: visible } } })
  }
  beforeAll(async () => {
    execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    releases = await import('../../server/services/releases/queries')
    issues = await import('../../server/services/issues/queries')
    comments = await import('../../server/services/comments/comments')
    plans = await import('../../server/services/plan/list')
    await clean()
    await db.qmsWorkOrder.createMany({ data: visible.map((workOrderNumber) => ({ workOrderNumber, customerName: '分页测试', quantity: 1, deliveryDate: now, status: 'IN_PROGRESS', updatedAt: now })) })
    await db.release.createMany({ data: Array.from({ length: 207 }, (_, i) => ({ id: `${prefix}release-${i}`, releaseNo: `${prefix}${i}`, workOrderNumber: visible[0]!, type: 'DRAWING', description: '分页', issuerId: actor.userId, createdAt: now })) })
    await db.issue.createMany({ data: visible.map((workOrderNumber, i) => ({ id: `${prefix}issue-${i}`, issueNo: `${prefix}${i}`, workOrderNumber, category: 'OTHER', source: 'MANUAL', description: '分页', status: (['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED'] as const)[i % 4], createdAt: now, dueDate: i % 2 ? new Date('2040-05-01') : null })) })
    await db.comment.createMany({ data: visible.map((_, i) => ({ id: `${prefix}comment-${i}`, refType: 'part', refId: `${prefix}part`, workOrderNumber: visible[0]!, authorId: actor.userId, body: '分页', createdAt: now })) })
  })
  afterAll(async () => { if (db) { await clean(); await db.$disconnect() } })

  it.each(['release', 'issue', 'comment', 'plan'] as const)('%s：三页读取与全量相等，无重复且 total 完整', async (kind) => {
    const ctx = { ...actor, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set<string>() }
    const all = kind === 'release' ? await releases.listReleases({ visibleWorkOrders: visible }, actor.userId)
      : kind === 'issue' ? await issues.listIssues({ visibleWorkOrders: visible }, actor, now)
      : kind === 'comment' ? await comments.listComments('part', `${prefix}part`)
      : (await plans.listPlans(visible, ctx, now)).rows
    const pages = []
    for (const page of [1, 2, 3]) {
      const input = { page, pageSize: kind === 'release' ? 100 : 3 }
      pages.push(kind === 'release' ? await releases.listReleasesPage({ visibleWorkOrders: visible }, actor.userId, input)
        : kind === 'issue' ? await issues.listIssuesPage({ visibleWorkOrders: visible }, actor, now, input)
        : kind === 'comment' ? await comments.listCommentsPage('part', `${prefix}part`, input)
        : await plans.listPlansPage(visible, ctx, now, input))
    }
    const key = (r: { id?: string; workOrderNumber?: string }) => r.id ?? r.workOrderNumber
    const ids = pages.flatMap((p) => p.rows.map(key))
    expect(ids).toEqual(all.map(key))
    expect(new Set(ids).size).toBe(all.length)
    expect(pages.every((p) => p.total === all.length)).toBe(true)
  })
})
