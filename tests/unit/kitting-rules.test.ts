/** 齐套（R12）的纯函数：齐套率（已取消不计）、工件就绪、缺件卡在哪一步、物料是否逾期 / 赶不上节点、W8 判定（黄 / 红窗口、上海日界） */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS as T } from '../../server/services/alerts/rules'
import {
  type PartFacts,
  countKit,
  isIncomplete,
  judgeW8,
  kitPercent,
  materialShortage,
  needText,
  partBlocker,
  w8Summary,
} from '../../server/services/kitting/constants'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)
/** 工厂时区 2026-10-17 10:00 */
const NOW = new Date('2026-10-17T02:00:00.000Z')

describe('齐套率', () => {
  it('已就绪 ÷ 应有；已取消的物料不计入应有项', () => {
    const c = countKit([{ status: 'DONE' }, { status: 'ACTIVE' }], [{ status: 'ARRIVED' }, { status: 'OPEN' }, { status: 'CANCELLED' }])
    expect(c).toEqual({ total: 4, ready: 2, readyDay: null })
    expect(kitPercent(c)).toBe(50)
    expect(isIncomplete(c)).toBe(true)
  })
  it('全部就绪 = 100%；只剩已取消的物料没到也算齐', () => {
    const c = countKit([{ status: 'DONE' }], [{ status: 'ARRIVED' }, { status: 'CANCELLED' }])
    expect(c).toEqual({ total: 2, ready: 2, readyDay: null }) // 没给日期字段
    expect(kitPercent(c)).toBe(100)
    expect(isIncomplete(c)).toBe(false)
  })
  it('向下取整：差一项不会显示成 100%；清单为空没有齐套率、不算未齐套', () => {
    const many = countKit(Array.from({ length: 199 }, () => ({ status: 'DONE' as const })), [{ status: 'OPEN' }])
    expect(kitPercent(many)).toBe(99)
    expect(kitPercent({ total: 0, ready: 0 })).toBeNull()
    expect(isIncomplete({ total: 0, ready: 0 })).toBe(false)
    // 只挂了已取消的物料 = 清单为空
    expect(countKit([], [{ status: 'CANCELLED' }])).toEqual({ total: 0, ready: 0, readyDay: null })
  })
  it('齐套日：全部就绪时取最后一项就绪的那天（工件完成时刻按工厂时区、物料到货日；已取消的不算）；缺日期或没齐为 null', () => {
    const part = (since: string) => ({ status: 'DONE' as const, statusSince: new Date(since) })
    // 工件 10-14 23:30 北京时间 = 10-14 15:30Z；物料 10-12 到货
    expect(countKit([part('2026-10-14T15:30:00Z')], [{ status: 'ARRIVED', arrivedDate: d('2026-10-12') }, { status: 'CANCELLED', arrivedDate: null }]).readyDay).toBe('2026-10-14')
    // 工件 10-14 17:00Z = 北京时间 10-15 01:00
    expect(countKit([part('2026-10-14T17:00:00Z')], []).readyDay).toBe('2026-10-15')
    expect(countKit([part('2026-10-14T15:30:00Z')], [{ status: 'ARRIVED', arrivedDate: null }]).readyDay).toBeNull()
    expect(countKit([part('2026-10-14T15:30:00Z')], [{ status: 'OPEN', arrivedDate: null }]).readyDay).toBeNull()
  })
})

describe('partBlocker：缺件卡在哪一步（只给一个主要原因）', () => {
  const step = (seq: number, status: PartFacts['steps'][number]['status'], processName: string, held = false) => ({ seq, status, processName, held, holdReleaseNo: held ? 'FF-261017-001' : null })
  const facts = (over: Partial<PartFacts>): PartFacts => ({ steps: [], openDrawings: [], openMaterials: [], ...over })

  it('当前工序 = 第一道未完成的；在制 / 外协中 / 有异常照实写，优先于图纸、物料', () => {
    const b = partBlocker(facts({ steps: [step(2, 'IN_PROGRESS', '涂装'), step(1, 'DONE', '组焊')], openDrawings: ['总图'], openMaterials: ['钢板'] }))
    expect(b).toMatchObject({ code: 'IN_PROGRESS', text: '在制', stage: '涂装' })
    expect(partBlocker(facts({ steps: [step(1, 'OUT', '组焊')] }))).toMatchObject({ code: 'OUT', text: '外协中', stage: '组焊' })
    expect(partBlocker(facts({ steps: [step(1, 'BLOCKED', '机加')] }))).toMatchObject({ code: 'BLOCKED', text: '有异常' })
  })
  it('还没开工：等变更 → 图纸未完成 → 待料 → 待开工', () => {
    const steps = [step(1, 'DONE', '下料'), step(2, 'PENDING', '机加', true)]
    expect(partBlocker(facts({ steps, openDrawings: ['总图'], openMaterials: ['钢板'] }))).toMatchObject({ code: 'HOLD', text: '等变更', stage: '机加', detail: 'FF-261017-001' })
    const pending = [step(1, 'PENDING', '组焊')]
    expect(partBlocker(facts({ steps: pending, openDrawings: ['总图'], openMaterials: ['钢板'] }))).toMatchObject({ code: 'DRAWING', text: '图纸未完成', detail: '总图' })
    expect(partBlocker(facts({ steps: pending, openMaterials: ['钢板', '回转支承', '减速机', '电机'] }))).toMatchObject({
      code: 'MATERIAL',
      text: '待料',
      detail: '钢板、回转支承、减速机 等 4 项',
    })
    expect(partBlocker(facts({ steps: pending }))).toMatchObject({ code: 'PENDING', text: '待开工', stage: '组焊' })
  })
  it('没有工序 = 未排工序（有设计任务时先报图纸）；工序都完成但工件没置完成 = 工序已完成', () => {
    expect(partBlocker(facts({}))).toMatchObject({ code: 'NO_ROUTE', stage: null })
    expect(partBlocker(facts({ openDrawings: ['总图'] }))).toMatchObject({ code: 'DRAWING' })
    expect(partBlocker(facts({ steps: [step(1, 'DONE', '组焊')] }))).toMatchObject({ code: 'STEPS_DONE' })
  })
})

describe('materialShortage：物料未到货', () => {
  it('逾期 = 已过承诺日或需求日；承诺日晚于节点需求日 = 赶不上节点', () => {
    const late = materialShortage({ status: 'OPEN', needDate: d('2026-10-30'), promisedDate: d('2026-10-15') }, d('2026-10-25'), NOW)
    expect(late).toEqual({ text: '超承诺日', overdue: true, lateForNode: false })
    const after = materialShortage({ status: 'OPEN', needDate: d('2026-10-30'), promisedDate: d('2026-10-28') }, d('2026-10-25'), NOW)
    expect(after).toEqual({ text: '待到货', overdue: false, lateForNode: true })
  })
  it('没有承诺日：节点需求日已到才算赶不上', () => {
    expect(materialShortage({ status: 'OPEN', needDate: d('2026-10-30'), promisedDate: null }, d('2026-10-25'), NOW)).toMatchObject({ text: '无承诺日', lateForNode: false })
    expect(materialShortage({ status: 'OPEN', needDate: d('2026-10-30'), promisedDate: null }, d('2026-10-17'), NOW)).toMatchObject({ lateForNode: true })
  })
})

describe('judgeW8：需求日前 N 天未齐套', () => {
  const kit = { total: 3, ready: 1 }
  const at = (need: string, now = NOW) => judgeW8({ ...kit, needDate: d(need), now }, T.W8).level
  it('默认前 5 天黄、前 1 天红（含当天、已过）；更远不预警', () => {
    expect(at('2026-10-23')).toBeNull() // 还剩 6 天
    expect(at('2026-10-22')).toBe('YELLOW') // 还剩 5 天
    expect(at('2026-10-19')).toBe('YELLOW') // 还剩 2 天
    expect(at('2026-10-18')).toBe('RED') // 明天
    expect(at('2026-10-17')).toBe('RED') // 今天
    expect(at('2026-10-01')).toBe('RED') // 已过
  })
  it('齐套（或清单为空）不预警', () => {
    expect(judgeW8({ total: 3, ready: 3, needDate: d('2026-10-17'), now: NOW }, T.W8).level).toBeNull()
    expect(judgeW8({ total: 0, ready: 0, needDate: d('2026-10-17'), now: NOW }, T.W8).level).toBeNull()
  })
  it('阈值可改：前 10 天黄、前 3 天红', () => {
    const t = { remindHours: null, yellowDays: 10, redDays: 3 }
    expect(judgeW8({ ...kit, needDate: d('2026-10-27'), now: NOW }, t).level).toBe('YELLOW')
    expect(judgeW8({ ...kit, needDate: d('2026-10-20'), now: NOW }, t).level).toBe('RED')
  })
  it('"今天"按上海日历：UTC 前一天 16:00 之后已经是上海的第二天', () => {
    // 2026-10-16T16:30Z = 上海 10-17 00:30：需求日 10-18 只剩 1 天 → 红；按 UTC 算会是 2 天（黄）
    expect(at('2026-10-18', new Date('2026-10-16T16:30:00.000Z'))).toBe('RED')
    expect(judgeW8({ ...kit, needDate: d('2026-10-18'), now: new Date('2026-10-16T16:30:00.000Z') }, T.W8).daysLeft).toBe(1)
  })
  it('标题文案：需求日、还剩几天、齐套几项、缺几项、负责人', () => {
    const r = judgeW8({ ...kit, needDate: d('2026-10-20'), now: NOW }, T.W8)
    expect(w8Summary(r, { needDate: d('2026-10-20') }, kit, '生产经理')).toBe('需求日 2026-10-20（还剩 3 天），齐套 1/3（33%），缺 2 项（生产经理）')
    expect(needText(d('2026-10-15'), -2)).toBe('需求日 2026-10-15（已过 2 天）')
    expect(needText(d('2026-10-17'), 0)).toBe('需求日 2026-10-17（就是今天）')
  })
})
