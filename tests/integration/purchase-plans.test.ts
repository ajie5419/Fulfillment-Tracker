import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const DB = process.env.TEST_DATABASE_URL
const WO = 'T-PURCHASE-PLAN'
describe.skipIf(!DB)('采购计划下发集成', () => {
  let db: PrismaClient
  let plans: typeof import('../../server/services/purchases/plans')
  let purchases: typeof import('../../server/services/purchases/purchases')
  let todos: typeof import('../../server/services/flow/todos')
  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    plans = await import('../../server/services/purchases/plans')
    purchases = await import('../../server/services/purchases/purchases')
    todos = await import('../../server/services/flow/todos')
    await db.purchasePlan.deleteMany({ where: { workOrderNumber: WO } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: WO } })
    await db.part.deleteMany({ where: { workOrderNumber: WO } })
    await db.qmsWorkOrder.upsert({ where: { workOrderNumber: WO }, create: { workOrderNumber: WO, customerName: '采购计划测试', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: new Date() }, update: { isDeleted: false } })
    for (const id of ['pp-tech', 'pp-buyer', 'pp-head']) await db.qmsUser.upsert({ where: { id }, create: { id, realName: id, username: id, status: 'ACTIVE', updatedAt: new Date() }, update: { status: 'ACTIVE', isDeleted: false } })
    await db.notifyRole.deleteMany({ where: { userId: 'pp-head' } })
    await db.notifyRole.create({ data: { userId: 'pp-head', role: 'DEPT_HEAD', department: '采购部' } })
  })
  afterAll(async () => {
    if (!db) return
    const ids = (await db.purchasePlan.findMany({ where: { workOrderNumber: WO }, select: { id: true } })).map(p => p.id)
    await db.todo.deleteMany({ where: { refType: 'purchasePlan', refId: { in: ids } } })
    await db.purchasePlan.deleteMany({ where: { workOrderNumber: WO } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: WO } })
    await db.part.deleteMany({ where: { workOrderNumber: WO } })
    await db.notifyRole.deleteMany({ where: { userId: 'pp-head' } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: WO } })
    await db.qmsUser.deleteMany({ where: { id: { in: ['pp-tech', 'pp-buyer', 'pp-head'] } } })
    await db.$disconnect()
  })
  const head = () => ({ workOrderNumber: WO, title: '第一批外购件', category: '主要外购件' })
  const item = (name = '减速机') => ({ materialName: name, spec: 'X1', quantity: 2.5, unit: '套', needDate: new Date('2026-12-01'), supplierName: '手填供应商', sortOrder: 0 })
  it('建计划→下发→负责人待办→逐行转入回链→到货完成度', async () => {
    const p = await plans.createPurchasePlan(head(), 'pp-tech')
    const i = await plans.savePurchasePlanItem(p.id, null, item())
    const j = await plans.savePurchasePlanItem(p.id, null, item('电机'))
    expect((await plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')).notified).toBeGreaterThan(0)
    expect(await db.todo.count({ where: { ownerId: 'pp-head', action: 'PURCHASE_PLAN_ISSUED', refId: p.id, status: 'OPEN' } })).toBe(1)
    expect((await todos.listMyTodos('pp-head', [WO])).find(t => t.refId === p.id)).toMatchObject({ title: expect.stringContaining('第一批外购件'), link: `/purchase-plans/${p.id}`, workOrderNumber: WO })
    expect((await todos.listMyTodos('pp-head', ['hidden'])).some(t => t.refId === p.id)).toBe(false)
    await expect(plans.savePurchasePlanItem(p.id, i.id, item('改名'))).rejects.toThrow('不可编辑')
    const r = await plans.convertPurchasePlan(p.id, [i.id], 'pp-buyer')
    expect(r).toMatchObject({ succeeded: 1, failed: 0 })
    const lineId = r.results[0]!.lineId!
    expect(await db.purchasePlanItem.findUnique({ where: { id: i.id } })).toMatchObject({ convertedLineId: lineId })
    expect(await db.purchaseLine.findUnique({ where: { id: lineId } })).toMatchObject({ materialName: '减速机', supplierName: '手填供应商', supplierId: null, buyerId: 'pp-buyer', workOrderNumber: WO })
    expect((await plans.getPurchasePlan(p.id)).progress).toEqual({ total: 2, converted: 1, arrived: 0 })
    await purchases.confirmArrival(lineId, { source: 'PC' }, 'pp-buyer')
    expect((await plans.getPurchasePlan(p.id)).progress).toEqual({ total: 2, converted: 1, arrived: 1 })
    expect((await plans.listPurchasePlans({ workOrderNumber: WO })).rows.find(x => x.id === p.id)?.progress.arrived).toBe(1)
    await purchases.undoArrival(lineId)
    expect((await plans.getPurchasePlan(p.id)).progress.arrived).toBe(0)
    expect((await plans.convertPurchasePlan(p.id, [i.id], 'pp-buyer')).failed).toBe(1)
    expect((await plans.convertPurchasePlan(p.id, [j.id], 'pp-buyer')).succeeded).toBe(1)
    expect(await db.todo.count({ where: { refId: p.id, status: 'OPEN' } })).toBe(0)
    await expect(purchases.deleteLine(lineId)).rejects.toThrow()
  })
  it('撤回作废未处理待办，再下发保留已转项且不重复转入', async () => {
    const p = await plans.createPurchasePlan(head(), 'pp-tech')
    const i = await plans.savePurchasePlanItem(p.id, null, item())
    await plans.savePurchasePlanItem(p.id, null, item('电器'))
    await plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')
    await plans.convertPurchasePlan(p.id, [i.id], 'pp-buyer')
    await plans.changePurchasePlanStatus(p.id, 'withdraw', 'pp-tech')
    expect(await db.todo.count({ where: { ownerId: 'pp-head', refId: p.id, status: 'CANCELLED' } })).toBe(1)
    await expect(plans.deletePurchasePlanItem(p.id, i.id)).rejects.toThrow('不可删除')
    await expect(plans.savePurchasePlanItem(p.id, i.id, item())).rejects.toThrow('不可修改')
    await expect(plans.convertPurchasePlan(p.id, undefined, 'pp-buyer')).rejects.toThrow('只有已下发')
    await plans.savePurchasePlanItem(p.id, null, item('新增'))
    await plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')
    expect((await plans.convertPurchasePlan(p.id, undefined, 'pp-buyer')).succeeded).toBe(2)
  })
  it('整单逐行事务：失败不连坐、失败不留采购行，重试可成功', async () => {
    const p = await plans.createPurchasePlan(head(), 'pp-tech')
    await plans.savePurchasePlanItem(p.id, null, item())
    const bad = await plans.savePurchasePlanItem(p.id, null, item('异常行'))
    await plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')
    // 模拟遗留或损坏数据；正式接口不会允许已下发后修改。
    await db.purchasePlanItem.update({ where: { id: bad.id }, data: { needDate: null } })
    const before = await db.purchaseLine.count({ where: { workOrderNumber: WO } })
    const r = await plans.convertPurchasePlan(p.id, undefined, 'pp-buyer')
    expect(r).toMatchObject({ succeeded: 1, failed: 1 })
    expect(await db.purchaseLine.count({ where: { workOrderNumber: WO } })).toBe(before + 1)
    expect((await db.purchasePlanItem.findUniqueOrThrow({ where: { id: bad.id } })).convertedLineId).toBeNull()
    await db.purchasePlanItem.update({ where: { id: bad.id }, data: { needDate: item().needDate } })
    expect((await plans.convertPurchasePlan(p.id, undefined, 'pp-buyer')).succeeded).toBe(1)
  })
  it('并发转同一行只创建一条采购行', async () => {
    const p = await plans.createPurchasePlan(head(), 'pp-tech')
    const i = await plans.savePurchasePlanItem(p.id, null, item())
    await plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')
    const results = await Promise.all([plans.convertPurchasePlan(p.id, [i.id], 'pp-buyer'), plans.convertPurchasePlan(p.id, [i.id], 'pp-buyer')])
    expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(1)
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(1)
  })
  it('空单和缺数量/日期的草稿不可下发', async () => {
    const p = await plans.createPurchasePlan(head(), 'pp-tech')
    await expect(plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')).rejects.toThrow('先添加')
    await plans.savePurchasePlanItem(p.id, null, { ...item(), quantity: 0, needDate: null })
    await expect(plans.changePurchasePlanStatus(p.id, 'issue', 'pp-tech')).rejects.toThrow('补齐')
  })
  it('BOM 无图号行按解析数量生成单张草稿，排除辅材；没有外购件不建', async () => {
    const bom = await import('../../server/services/bom/excel')
    const rows = [
      { row: 2, drawingNo: null, revision: null, name: '自动电机', quantity: 3 },
      { row: 3, drawingNo: null, revision: null, name: '六角螺母', quantity: 20 },
      { row: 4, drawingNo: null, revision: null, name: '待核对外购件', quantity: null },
    ]
    const before = await db.purchasePlan.count({ where: { workOrderNumber: WO } })
    // 预览使用的纯归类不会写库。
    expect(bom.classifyBom(rows, []).lines).toHaveLength(3)
    expect(await db.purchasePlan.count({ where: { workOrderNumber: WO } })).toBe(before)
    const result = await db.$transaction(tx => bom.applyTechBom(tx, WO, rows, { createdBy: 'pp-tech' }))
    expect(result.purchasePlanItems).toBe(2)
    const p = await plans.getPurchasePlan(result.purchasePlanId!)
    expect(p).toMatchObject({ source: 'BOM_AUTO', status: 'DRAFT', createdBy: 'pp-tech' })
    expect(p.items.map(i => [i.materialName, i.quantity, i.needDate])).toEqual([['自动电机', 3, null], ['待核对外购件', 0, null]])
    expect(await db.purchasePlan.count({ where: { workOrderNumber: WO } })).toBe(before + 1)
    const no = await db.$transaction(tx => bom.applyTechBom(tx, WO, [{ row: 2, drawingNo: 'PP-DRAW', revision: null, name: '图号工件', quantity: 1 }], { createdBy: 'pp-tech' }))
    expect(no.purchasePlanId).toBeUndefined()
    expect(await db.purchasePlan.count({ where: { workOrderNumber: WO } })).toBe(before + 1)
  })
  it('BOM 应用后事务失败，采购计划与新工件一起回滚', async () => {
    const bom = await import('../../server/services/bom/excel')
    const before = await db.purchasePlan.count({ where: { workOrderNumber: WO } })
    await expect(db.$transaction(async tx => {
      await bom.applyTechBom(tx, WO, [
        { row: 2, drawingNo: 'PP-ROLLBACK', revision: null, name: '回滚工件', quantity: 1 },
        { row: 3, drawingNo: null, revision: null, name: '回滚采购件', quantity: 2 },
      ], { createdBy: 'pp-tech' })
      throw new Error('后续发放失败')
    })).rejects.toThrow('后续发放失败')
    expect(await db.purchasePlan.count({ where: { workOrderNumber: WO } })).toBe(before)
    expect(await db.part.count({ where: { workOrderNumber: WO, drawingNo: 'PP-ROLLBACK' } })).toBe(0)
  })

})
