/**
 * 第二批（10-26 借鉴 ERPNext 页面交互）：留言 @人、全局搜索、车间看板、工件时间线和关联记录数。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  finish: typeof import('../../server/services/flow/finish')
  comments: typeof import('../../server/services/comments/comments')
  reminders: typeof import('../../server/services/alerts/reminders')
  search: typeof import('../../server/services/search/search')
  workshop: typeof import('../../server/services/flow/workshop')
  timeline: typeof import('../../server/services/flow/timeline')
  purchases: typeof import('../../server/services/purchases/purchases')
}

describe.skipIf(!DB)('留言、搜索、车间看板、时间线', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-COL-1'
  const WO2 = 'T-COL-2'
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      finish: await import('../../server/services/flow/finish'),
      comments: await import('../../server/services/comments/comments'),
      reminders: await import('../../server/services/alerts/reminders'),
      search: await import('../../server/services/search/search'),
      workshop: await import('../../server/services/flow/workshop'),
      timeline: await import('../../server/services/flow/timeline'),
      purchases: await import('../../server/services/purchases/purchases'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await db.comment.deleteMany()
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.issue.deleteMany()
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
    await db.unmatchedInspection.deleteMany()
    await db.paymentLine.deleteMany()
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsUser.deleteMany()

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [
        { workOrderNumber: WO, projectName: '架桥机甲', customerName: '客户甲', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: WO2, projectName: '风电模具乙', customerName: '客户乙', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now },
      ],
    })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'S-PAINT', name: '华东涂装厂', updatedAt: now },
        { id: 'T-WELD', name: '焊接一班', kind: 'TEAM', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'P-CUT', name: '下料', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-WELD', name: '组焊', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-PAINT', name: '涂装', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsUser.createMany({
      data: [
        { id: 'u-a', username: 'a', realName: '甲', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: now },
        { id: 'u-b', username: 'b', realName: '乙', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: now },
        { id: 'u-c', username: 'c', realName: '丙', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: now },
      ],
    })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  /** 下料（自制，焊接一班）→ 组焊（自制）→ 涂装（厂外） */
  async function makePart(wo: string, name: string, drawingNo?: string) {
    const part = await s.steps.createPart(wo, { name, quantity: 2, drawingNo })
    const cut = await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', supplierId: 'T-WELD', ownerId: 'u-a' }, 'u-a')
    const weld = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF', ownerId: 'u-a', dueDate: day('2026-01-05') }, 'u-a')
    const paint = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-PAINT', ownerId: 'u-a' }, 'u-a')
    return { part, cut, weld, paint }
  }

  it('留言 @人：被 @ 的收到提醒（跳回工件、带工单号），自己不提醒自己；校验内容和人', async () => {
    const { part } = await makePart(WO, '主梁')
    await expect(s.comments.addComment({ refType: 'part', refId: part.id, body: '  ' }, 'u-a')).rejects.toThrow('请填写留言内容')
    await expect(s.comments.addComment({ refType: 'part', refId: part.id, body: 'x', mentionIds: ['u-nobody'] }, 'u-a')).rejects.toThrow('不存在')
    await expect(s.comments.addComment({ refType: 'part', refId: 'nope', body: 'x' }, 'u-a')).rejects.toThrow('不存在')

    await s.comments.addComment({ refType: 'part', refId: part.id, body: '下料尺寸请复核', mentionIds: ['u-b', 'u-a', 'u-b'] }, 'u-a')
    const list = await s.comments.listComments('part', part.id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ authorName: '甲', body: '下料尺寸请复核', mentions: [{ id: 'u-b', name: '乙' }] })
    expect(await db.reminder.count({ where: { userId: 'u-a', kind: 'COMMENT' } })).toBe(0)

    const r = await s.reminders.listReminders('u-b')
    const item = r.items.find((i) => i.kind === 'COMMENT')
    expect(item?.title).toContain('甲 在工件"主梁"提到你：下料尺寸请复核')
    expect(item?.link).toBe(`/parts?wo=${WO}&part=${part.id}&comments=1`)
    expect(item?.workOrderNumber).toBe(WO)
    expect(r.unread).toBe(1)
    expect((await s.comments.countComments('part', [part.id])).get(part.id)).toBe(1)
  })

  it('采购行也能留言，提醒跳到采购页', async () => {
    const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, materialName: 'Q355 钢板', supplierName: '宝钢', quantity: 2, needDate: day('2026-11-20') } })
    await s.comments.addComment({ refType: 'purchase', refId: line.id, body: '能否提前', mentionIds: ['u-c'] }, 'u-a')
    const rem = await db.reminder.findFirstOrThrow({ where: { userId: 'u-c', kind: 'COMMENT' } })
    expect(rem.link).toBe(`/purchases?wo=${WO}&id=${line.id}&comments=1`)
  })

  it('不能 @ 看不到该工单的人（只看本人工单的项目经理）；工件、采购行删除时留言和 @ 提醒一起删', async () => {
    await db.qmsUser.create({ data: { id: 'u-pm2', username: 'pm2', realName: '丁', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: new Date() } })
    await db.workOrderExt.upsert({ where: { workOrderNumber: WO2 }, create: { workOrderNumber: WO2, projectManagerId: 'u-pm2' }, update: { projectManagerId: 'u-pm2' } })
    try {
      const { part } = await makePart(WO, '不可见件')
      await expect(s.comments.addComment({ refType: 'part', refId: part.id, body: 'x', mentionIds: ['u-pm2'] }, 'u-a')).rejects.toThrow(`丁 看不到工单 ${WO}`)
      expect(await db.reminder.count({ where: { userId: 'u-pm2' } })).toBe(0)
      // 管理员不受限
      await s.comments.addComment({ refType: 'part', refId: part.id, body: 'y', mentionIds: ['u-pm2'] }, 'u-a', ['u-pm2'])

      const bare = await db.part.create({ data: { workOrderNumber: WO, name: '待删件', quantity: 1 } })
      const keep = await db.reminder.count({ where: { kind: 'COMMENT' } }) // 别的记录上的留言提醒不能被误删
      await s.comments.addComment({ refType: 'part', refId: bare.id, body: '删前留言', mentionIds: ['u-c'] }, 'u-a')
      expect(await db.reminder.count({ where: { kind: 'COMMENT' } })).toBe(keep + 1)
      await s.steps.deletePart(bare.id)
      expect(await db.comment.count({ where: { refId: bare.id } })).toBe(0)
      expect(await db.reminder.count({ where: { kind: 'COMMENT' } })).toBe(keep) // @ 提醒一起删，不留指向已删工件的链接
      const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, materialName: '待删料', quantity: 1, needDate: day('2026-11-20') } })
      await s.comments.addComment({ refType: 'purchase', refId: line.id, body: '删前留言', mentionIds: ['u-c'] }, 'u-a')
      await s.purchases.deleteLine(line.id)
      expect(await db.comment.count({ where: { refId: line.id } })).toBe(0)
      expect(await db.reminder.count({ where: { kind: 'COMMENT' } })).toBe(keep)
    } finally {
      await db.workOrderExt.deleteMany({ where: { workOrderNumber: WO2 } })
    }
  })

  it('全局搜索：工单、工件 / 图号、采购物料 / 供应商、外协厂 / 班组；只搜可见工单；少于 2 个字不搜', async () => {
    await makePart(WO2, '模具底板', 'DWG-778')
    expect(await s.search.search('a')).toEqual([])
    const byDrawing = await s.search.search('DWG-778')
    expect(byDrawing.map((h) => [h.type, h.title])).toEqual([['part', '模具底板']])
    expect(byDrawing[0]!.link).toContain(`/parts?wo=${WO2}&part=`)
    expect((await s.search.search('风电')).map((h) => h.type)).toEqual(['workOrder'])
    expect((await s.search.search('宝钢')).map((h) => h.type)).toEqual(['purchase'])
    const sup = await s.search.search('焊接一班')
    expect(sup).toEqual([expect.objectContaining({ type: 'supplier', id: 'T-WELD', link: '/workshop?supplierId=T-WELD' })])
    expect(sup[0]!.sub).toContain('厂内班组')
    // 项目经理只看本人工单：WO2 的工件搜不到
    expect(await s.search.search('DWG-778', [WO])).toEqual([])
  })

  it('车间看板：待开工只列"可以开工"的（第一道、或上一道已完成 / 已有报工）；按班组筛；完成的进近 7 天', async () => {
    const { cut, weld, paint } = await makePart(WO, '支腿')
    const col = async (f: Parameters<typeof s.workshop.listWorkshop>[0]) => Object.fromEntries((await s.workshop.listWorkshop({ workOrderNumber: WO, ...f })).map((c) => [c.key, c.cards.map((x) => x.stepId)]))
    let b = await col({})
    expect(b.ready).toContain(cut.id)
    expect(b.ready).not.toContain(weld.id)
    // 下料报工 1 件：组焊可以开工了，下料在加工中
    await s.finish.finishStep({ stepId: cut.id, actorId: 'u-a', source: 'PC', qty: 1, rest: 'CONTINUE' })
    b = await col({})
    expect(b.working).toContain(cut.id)
    expect(b.ready).toContain(weld.id)
    // 按班组筛：只剩焊接一班的下料
    const team = await col({ supplierId: 'T-WELD' })
    expect(team.working).toEqual([cut.id])
    expect(team.ready).not.toContain(weld.id) // 组焊没派班组
    // 组焊开工后超期（要求完成日 2026-01-05 早已过）
    await s.flow.startStep({ stepId: weld.id, actorId: 'u-a', source: 'PC' })
    const all = await s.workshop.listWorkshop({ workOrderNumber: WO })
    const weldCard = all.find((c) => c.key === 'working')!.cards.find((c) => c.stepId === weld.id)!
    expect(weldCard.overdueDays).toBeGreaterThan(0)
    await s.finish.finishStep({ stepId: cut.id, actorId: 'u-a', source: 'PC' })
    b = await col({})
    expect(b.done).toContain(cut.id)
    expect(b.ready).not.toContain(paint.id) // 组焊还没回来
  })

  it('工件时间线和关联记录数', async () => {
    const { part, cut } = await makePart(WO, '回转底座')
    await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '回转支承', quantity: 1, needDate: day('2026-11-20'), status: 'ARRIVED', arrivedDate: day('2026-11-18'), arrivedAt: new Date() } })
    await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '螺栓', quantity: 1, needDate: day('2026-11-20') } })
    await s.finish.finishStep({ stepId: cut.id, actorId: 'u-a', source: 'MOBILE', qty: 1, rest: 'SCRAP', note: '割偏' })
    await s.comments.addComment({ refType: 'part', refId: part.id, body: '补料已安排' }, 'u-b')

    const t = await s.timeline.partTimeline(part.id)
    const kinds = t!.entries.map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['part', 'purchase', 'flow', 'issue', 'comment']))
    expect(t!.entries.at(-1)!.title).toBe('建档') // 新的在上，建档最早
    expect(t!.entries.some((e) => e.title.includes('报废 1 件') && e.tone === 'late' && e.sub?.includes('割偏'))).toBe(true)
    expect(t!.entries.some((e) => e.title === '到货"回转支承"' && e.tone === 'done')).toBe(true)

    const counts = (await s.timeline.partRelatedCounts([part.id])).get(part.id)
    expect(counts).toEqual({ drawings: 0, drawingsDone: 0, purchases: 2, purchasesArrived: 1, openIssues: 1, comments: 1 })
    // 工件列表带上关联记录数
    const listed = (await s.steps.listParts(WO)).find((p) => p.id === part.id)
    expect(listed?.related).toEqual(counts)
    expect(await s.timeline.partTimeline('nope')).toBeNull()
  })
})
