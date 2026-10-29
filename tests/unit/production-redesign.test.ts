/** 生产管理重设计第一批：统一"可以开工"口径（readiness.ts）、生产调度页签和主按钮、工序编排的筛选 / 状态 / 工序链色块 */
import { describe, expect, it } from 'vitest'
import { firstStepTodoReady, prereqMet, prereqReadyForTodo, prereqState, stepReadiness, stuckText } from '../../server/services/flow/readiness'
import { chainTones, inTab, isOverdue, partHeadline, primaryAction, routeFilterOf, segOfColumn, stepLate, stepLinkTab, tabCounts, tabForRow, type AlertLevelLike, type ProductionRowLike, type StepLike, type StepStatus } from '../../shared/production'

describe('prereqState：工件开工前提', () => {
  it('已取消的物料、设计任务不算；没挂东西 = 不跟踪、也算齐', () => {
    expect(prereqState({ purchases: [], drawings: [] })).toEqual({ tracked: false, missingMaterial: 0, missingDrawing: 0, missingMaterialList: 0 })
    expect(prereqState({ purchases: ['CANCELLED'], drawings: [{ status: 'CANCELLED', materialStatus: 'ISSUED' }] })).toEqual({ tracked: false, missingMaterial: 0, missingDrawing: 0, missingMaterialList: 0 })
    const s = prereqState({ purchases: ['ARRIVED', 'OPEN', 'CANCELLED'], drawings: [{ status: 'DONE', materialStatus: 'ISSUED' }, { status: 'DRAWN', materialStatus: 'ISSUED' }] })
    expect(s).toEqual({ tracked: true, missingMaterial: 1, missingDrawing: 1, missingMaterialList: 0 })
    expect(prereqMet(s)).toBe(false)
  })
  it('待办只在"挂了东西且都齐了"时发；生产调度"没挂东西"也算齐', () => {
    const none = prereqState({ purchases: [], drawings: [] })
    expect(prereqMet(none)).toBe(true)
    expect(prereqReadyForTodo(none)).toBe(false)
    const all = prereqState({ purchases: ['ARRIVED'], drawings: [{ status: 'DONE', materialStatus: 'ISSUED' }] })
    expect(prereqReadyForTodo(all)).toBe(true)
  })
})

describe('料单纳入第一道开工前提', () => {
  const first = { status: 'PENDING' as const, held: false }
  for (const materialStatus of ['NOT_STARTED', 'DRAFTING', 'REVISING', 'ISSUED'] as const) {
    it(`${materialStatus}：只有已下发放行`, () => {
      const prereq = prereqState({ purchases: ['ARRIVED'], drawings: [{ status: 'DONE', materialStatus }] })
      const ready = materialStatus === 'ISSUED'
      expect(prereq.missingMaterialList).toBe(ready ? 0 : 1)
      expect(prereqMet(prereq)).toBe(ready)
      expect(prereqReadyForTodo(prereq)).toBe(ready)
      expect(firstStepTodoReady(first, prereq)).toBe(ready)
      expect(stepReadiness({ ...first, prev: null, prereq })).toEqual({ ready, reason: ready ? null : 'MATERIAL_LIST' })
      expect(stepReadiness({ ...first, held: true, prev: null, prereq }).reason).toBe(ready ? 'HELD' : 'MATERIAL_LIST')
      expect(stepReadiness({ ...first, status: 'IN_PROGRESS', prev: null, prereq }).reason).toBeNull()
      expect(stepReadiness({ ...first, prev: { status: 'DONE', doneQty: 1 }, prereq }).ready).toBe(true)
    })
  }
  it('无关联设计任务、已取消任务都不受料单限制', () => {
    for (const drawings of [[], [{ status: 'CANCELLED' as const, materialStatus: 'REVISING' as const }]]) {
      const prereq = prereqState({ purchases: ['ARRIVED'], drawings })
      expect(firstStepTodoReady(first, prereq)).toBe(true)
      expect(prereq.missingMaterialList).toBe(0)
    }
    expect(stuckText('MATERIAL_LIST')).toBe('料单未下发')
  })
})

describe('stepReadiness：统一的"可以开工"', () => {
  const ok = { tracked: true, missingMaterial: 0, missingDrawing: 0, missingMaterialList: 0 }
  const base = { status: 'PENDING' as const, held: false, prev: null, prereq: ok }
  it('不是待开工的：不算可以开工，也没有原因', () => {
    expect(stepReadiness({ ...base, status: 'IN_PROGRESS' })).toEqual({ ready: false, reason: null })
  })
  it('第一道：物料、设计都齐才可以开工；缺料优先于缺图', () => {
    expect(stepReadiness(base)).toEqual({ ready: true, reason: null })
    expect(stepReadiness({ ...base, prereq: { tracked: true, missingMaterial: 2, missingDrawing: 1, missingMaterialList: 0 } }).reason).toBe('MATERIAL')
    expect(stepReadiness({ ...base, prereq: { tracked: true, missingMaterial: 0, missingDrawing: 1, missingMaterialList: 0 } }).reason).toBe('DRAWING')
    expect(stepReadiness({ ...base, prereq: { tracked: false, missingMaterial: 0, missingDrawing: 0, missingMaterialList: 0 } }).ready).toBe(true)
  })
  it('其余道：上一道完成或已有部分返回 / 报工；不看物料（物料只管第一道）', () => {
    const missing = { tracked: true, missingMaterial: 3, missingDrawing: 0, missingMaterialList: 0 }
    expect(stepReadiness({ ...base, prereq: missing, prev: { status: 'DONE', doneQty: 0 } }).ready).toBe(true)
    expect(stepReadiness({ ...base, prev: { status: 'OUT', doneQty: 1 } }).ready).toBe(true)
    expect(stepReadiness({ ...base, prev: { status: 'IN_PROGRESS', doneQty: 0 } })).toEqual({ ready: false, reason: 'PREV_NOT_DONE' })
  })
  it('等变更：本来能开工的算卡住；上一道没做完的仍是排队中', () => {
    expect(stepReadiness({ ...base, held: true })).toEqual({ ready: false, reason: 'HELD' })
    expect(stepReadiness({ ...base, held: true, prev: { status: 'PENDING', doneQty: 0 } }).reason).toBe('PREV_NOT_DONE')
  })
  it('卡住原因写明缺几项', () => {
    expect(stuckText('MATERIAL', { tracked: true, missingMaterial: 2, missingDrawing: 0, missingMaterialList: 0 })).toContain('2 项')
    expect(stuckText('BLOCKED')).toContain('不合格')
  })
})

describe('生产调度：页签、超期、主按钮', () => {
  const row = (o: Partial<ProductionRowLike>): ProductionRowLike => ({ column: 'ready', status: 'PENDING', mode: 'SELF', ownerId: 'u1', overdueDays: 0, startLateDays: 0, ...o })
  it('进行中 = 加工中 + 在外；已超期含应开工日已过；完成的不算超期', () => {
    expect(inTab(row({ column: 'working', status: 'IN_PROGRESS' }), 'active')).toBe(true)
    expect(inTab(row({ column: 'out', status: 'OUT' }), 'active')).toBe(true)
    expect(isOverdue(row({ startLateDays: 1 }))).toBe(true)
    expect(isOverdue(row({ column: 'done', status: 'DONE', overdueDays: 3 }))).toBe(false)
    const c = tabCounts([row({}), row({ column: 'working', overdueDays: 2 }), row({ column: 'stuck', status: 'BLOCKED' })])
    expect(c).toEqual({ ready: 1, active: 1, overdue: 1, stuck: 1, done: 0 })
  })
  it('主按钮：没负责人先指定；厂外发出、其余开工；加工中完工；在外登记返厂；卡住和完成没有', () => {
    expect(primaryAction(row({ ownerId: null }))).toBe('assign')
    expect(primaryAction(row({ mode: 'EXTERNAL_OUTSOURCE' }))).toBe('send')
    expect(primaryAction(row({ mode: 'IN_PLANT_OUTSOURCE' }))).toBe('start')
    expect(primaryAction(row({ column: 'working', status: 'IN_PROGRESS' }))).toBe('finish')
    expect(primaryAction(row({ column: 'out', status: 'OUT' }))).toBe('return')
    expect(primaryAction(row({ column: 'stuck', status: 'BLOCKED' }))).toBeNull()
    expect(primaryAction(row({ column: 'done', status: 'DONE' }))).toBeNull()
  })
})

describe('工序编排：筛选、一句话状态、工序链色块', () => {
  const today = '2026-10-26'
  const st = (o: Partial<StepLike>): StepLike => ({ status: 'PENDING', mode: 'SELF', needsFill: false, holdReleaseId: null, dueDate: null, promisedReturnDate: null, ...o })
  it('未排工序 / 待补充 / 已排好', () => {
    expect(routeFilterOf({ status: 'ACTIVE', steps: [] })).toBe('none')
    expect(routeFilterOf({ status: 'ACTIVE', steps: [st({ needsFill: true })] })).toBe('fill')
    expect(routeFilterOf({ status: 'ACTIVE', steps: [st({})] })).toBe('ok')
  })
  it('超期：在外看承诺返回日，其余看要求完成日；今天到期不算', () => {
    expect(stepLate(st({ dueDate: '2026-10-25' }), today)).toBe(true)
    expect(stepLate(st({ dueDate: '2026-10-26' }), today)).toBe(false)
    expect(stepLate(st({ status: 'OUT', dueDate: '2026-10-20', promisedReturnDate: '2026-10-30' }), today)).toBe(false)
    expect(stepLate(st({ status: 'DONE', dueDate: '2026-10-01' }), today)).toBe(false)
  })
  it('一句话状态按优先级：有异常 > 超期 > 未排 > 待补充 > 等变更 > 已完成 > 进行中 > 未开工', () => {
    expect(partHeadline({ status: 'ACTIVE', steps: [st({ status: 'BLOCKED' }), st({ dueDate: '2026-10-01' })] }, today)).toEqual({ tone: 'late', text: '1 道有异常' })
    expect(partHeadline({ status: 'ACTIVE', steps: [st({ dueDate: '2026-10-01', needsFill: true })] }, today).text).toBe('1 道超期')
    expect(partHeadline({ status: 'ACTIVE', steps: [] }, today).text).toBe('未排工序')
    expect(partHeadline({ status: 'ACTIVE', steps: [st({ needsFill: true }), st({ needsFill: true })] }, today).text).toBe('2 道待补充')
    expect(partHeadline({ status: 'ACTIVE', steps: [st({ holdReleaseId: 'r1' })] }, today).text).toBe('等变更')
    expect(partHeadline({ status: 'DONE', steps: [st({ status: 'DONE' })] }, today).text).toBe('已完成')
    expect(partHeadline({ status: 'ACTIVE', steps: [st({ status: 'DONE' }), st({})] }, today).text).toBe('进行中')
    expect(partHeadline({ status: 'ACTIVE', steps: [st({})] }, today).text).toBe('未开工')
  })
  it('色块：完成绿、第一道没完成的为当前、超期 / 异常红、其余灰', () => {
    expect(chainTones([st({ status: 'DONE' }), st({}), st({})], today)).toEqual(['done', 'current', 'todo'])
    expect(chainTones([st({ status: 'DONE' }), st({ status: 'IN_PROGRESS', dueDate: '2026-10-20' }), st({ status: 'BLOCKED' })], today)).toEqual(['done', 'late', 'blocked'])
  })
})

describe('提醒 / 预警的跳转页签：一定能看到被提到的那道工序', () => {
  const row = (o: Partial<ProductionRowLike>): ProductionRowLike => ({ column: 'ready', status: 'PENDING', mode: 'SELF', ownerId: 'u1', overdueDays: 0, startLateDays: 0, ...o })
  // 每种预警在工序当时状态下，生产调度列表里这道工序的样子（与 listProduction 的口径一致）
  const cases: { name: string; status: StepStatus; level: AlertLevelLike | null; row: ProductionRowLike }[] = [
    { name: 'W10 提醒级（要求完成日前 2 天）', status: 'IN_PROGRESS', level: 'REMIND', row: row({ column: 'working', status: 'IN_PROGRESS', overdueDays: 0 }) },
    { name: 'W10 黄（超 1 天）', status: 'IN_PROGRESS', level: 'YELLOW', row: row({ column: 'working', status: 'IN_PROGRESS', overdueDays: 1 }) },
    { name: 'W10 红（超 3 天）', status: 'IN_PROGRESS', level: 'RED', row: row({ column: 'working', status: 'IN_PROGRESS', overdueDays: 3 }) },
    { name: 'W3 提醒级（承诺返回日前）', status: 'OUT', level: 'REMIND', row: row({ column: 'out', status: 'OUT', mode: 'EXTERNAL_OUTSOURCE', overdueDays: 0 }) },
    { name: 'W3 黄', status: 'OUT', level: 'YELLOW', row: row({ column: 'out', status: 'OUT', mode: 'EXTERNAL_OUTSOURCE', overdueDays: 1 }) },
    { name: 'W2 转序停滞（可以开工没人动）', status: 'PENDING', level: 'YELLOW', row: row({ column: 'ready' }) },
    { name: 'W2 应开工日也过了', status: 'PENDING', level: 'RED', row: row({ column: 'ready', startLateDays: 2 }) },
    { name: '有异常', status: 'BLOCKED', level: null, row: row({ column: 'stuck', status: 'BLOCKED' }) },
    { name: '已消除（已完成）', status: 'DONE', level: 'YELLOW', row: row({ column: 'done', status: 'DONE', overdueDays: 0 }) },
  ]
  for (const c of cases) {
    it(`${c.name}：链接页签里就有这道`, () => {
      expect(inTab(c.row, stepLinkTab(c.status, c.level))).toBe(true)
    })
  }
  it('待开工但缺料 / 等变更（在"卡住"）：链接猜"可以开工"，页面按工序实际所在切到"卡住"', () => {
    const stuck = row({ column: 'stuck' })
    const hint = stepLinkTab('PENDING', 'YELLOW')
    expect(inTab(stuck, hint)).toBe(false)
    expect(tabForRow(stuck, hint)).toBe('stuck')
    expect(inTab(stuck, tabForRow(stuck, hint))).toBe(true)
  })
  it('提示页签里有它就不换（如超期又在做的，链接给"已超期"就停在"已超期"）', () => {
    expect(tabForRow(row({ column: 'working', status: 'IN_PROGRESS', overdueDays: 2 }), 'overdue')).toBe('overdue')
  })
  it('手机分段：能开工 / 在做 / 在外各对各的；卡住、完成不在手机分段里', () => {
    expect([segOfColumn('ready'), segOfColumn('working'), segOfColumn('out'), segOfColumn('stuck'), segOfColumn('done')]).toEqual(['ready', 'working', 'out', null, null])
  })
})
