/** 设计出图任务（R11）的纯函数：状态推导、W7 判定（出图到期 / 逾期、客户确认超期、停工日）、逾期口径、本周范围 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS as T } from '../../server/services/alerts/rules'
import { type W7Input, canReleaseFrom, deriveStatus, isOverdue, judgeW7, thisWeek, w7Summary } from '../../server/services/drawings/constants'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)
/** 工厂时区 2026-10-17（周六）10:00 */
const NOW = new Date('2026-10-17T02:00:00.000Z')

const base: W7Input = {
  status: 'PENDING',
  planDate: d('2026-10-25'),
  drawnDate: null,
  needsCustomerConfirm: false,
  customerPlanDate: null,
  customerConfirmedDate: null,
  now: NOW,
  offDays: [],
}

describe('deriveStatus：状态由事实推出', () => {
  const f = { cancelled: false, drawnDate: null as Date | null, needsCustomerConfirm: false, customerConfirmedDate: null as Date | null, released: false }
  it('待出图 → 已出图（未发放）→ 已完成；需要客户确认时 已发放未确认 = 待客户确认', () => {
    expect(deriveStatus(f)).toBe('PENDING')
    expect(deriveStatus({ ...f, drawnDate: d('2026-10-10') })).toBe('DRAWN')
    expect(deriveStatus({ ...f, drawnDate: d('2026-10-10'), released: true })).toBe('DONE')
    const confirm = { ...f, drawnDate: d('2026-10-10'), needsCustomerConfirm: true }
    expect(deriveStatus({ ...confirm, released: true })).toBe('CUSTOMER_PENDING')
    expect(deriveStatus({ ...confirm, released: true, customerConfirmedDate: d('2026-10-12') })).toBe('DONE')
    // 先确认、后发放：发放前仍是 已出图
    expect(deriveStatus({ ...confirm, customerConfirmedDate: d('2026-10-12') })).toBe('DRAWN')
  })
  it('取消优先；发放单作废后（released = false）回到 已出图', () => {
    expect(deriveStatus({ ...f, cancelled: true, drawnDate: d('2026-10-10'), released: true })).toBe('CANCELLED')
    expect(deriveStatus({ ...f, drawnDate: d('2026-10-10'), released: false })).toBe('DRAWN')
  })
  it('能一键发放的状态：出图之后（含已完成再发一版）', () => {
    expect(canReleaseFrom('PENDING')).toBe(false)
    expect(canReleaseFrom('CANCELLED')).toBe(false)
    expect(['DRAWN', 'CUSTOMER_PENDING', 'DONE'].every((s) => canReleaseFrom(s as 'DRAWN'))).toBe(true)
  })
})

describe('judgeW7：出图', () => {
  it('计划完成日前 2 天以外不预警；前 2 天内（含当天）未出图 → 黄', () => {
    expect(judgeW7({ ...base, planDate: d('2026-10-20') }, T.W7)).toMatchObject({ level: null, trigger: null, daysLeft: 3 })
    expect(judgeW7({ ...base, planDate: d('2026-10-19') }, T.W7)).toMatchObject({ level: 'YELLOW', trigger: 'DRAW_DUE', daysLeft: 2 })
    expect(judgeW7({ ...base, planDate: d('2026-10-17') }, T.W7)).toMatchObject({ level: 'YELLOW', trigger: 'DRAW_DUE', daysLeft: 0 })
  })
  it('已过计划完成日 → 红（超期天数不含停工日；全是停工日时先保持黄）', () => {
    expect(judgeW7({ ...base, planDate: d('2026-10-16') }, T.W7)).toMatchObject({ level: 'RED', trigger: 'DRAW_OVERDUE', overdueDays: 1, daysLeft: -1 })
    expect(judgeW7({ ...base, planDate: d('2026-10-16'), offDays: ['2026-10-17'] }, T.W7)).toMatchObject({ level: 'YELLOW', trigger: 'DRAW_OVERDUE', overdueDays: 0 })
    expect(judgeW7({ ...base, planDate: d('2026-10-14'), offDays: ['2026-10-15', '2026-10-16'] }, T.W7)).toMatchObject({ level: 'RED', overdueDays: 1 })
  })
  it('提醒窗口按阈值（remindHours / 24）', () => {
    expect(judgeW7({ ...base, planDate: d('2026-10-22') }, { ...T.W7, remindHours: 5 * 24 })).toMatchObject({ level: 'YELLOW', trigger: 'DRAW_DUE' })
  })
  it('已完成、已取消不预警；已出图不再按出图计划日判', () => {
    expect(judgeW7({ ...base, planDate: d('2026-10-01'), status: 'DONE' }, T.W7).level).toBeNull()
    expect(judgeW7({ ...base, planDate: d('2026-10-01'), status: 'CANCELLED' }, T.W7).level).toBeNull()
    expect(judgeW7({ ...base, planDate: d('2026-10-01'), status: 'DRAWN', drawnDate: d('2026-10-05') }, T.W7).level).toBeNull()
  })
})

describe('judgeW7：客户确认（独立节点）', () => {
  const drawn = { ...base, status: 'DRAWN' as const, planDate: d('2026-10-01'), drawnDate: d('2026-10-01'), needsCustomerConfirm: true }
  it('超客户确认计划日 1 天黄，再过 3 天（共 4 天）红；当天到期不算', () => {
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-17') }, T.W7)).toMatchObject({ level: null })
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-16') }, T.W7)).toMatchObject({ level: 'YELLOW', trigger: 'CONFIRM_OVERDUE', overdueDays: 1 })
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-14') }, T.W7)).toMatchObject({ level: 'YELLOW', overdueDays: 3 })
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-13') }, T.W7)).toMatchObject({ level: 'RED', trigger: 'CONFIRM_OVERDUE', overdueDays: 4 })
  })
  it('停工日不计入客户确认超期天数', () => {
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-13'), offDays: ['2026-10-15'] }, T.W7)).toMatchObject({ level: 'YELLOW', overdueDays: 3 })
  })
  it('已确认、不需要确认、没填计划日、还没出图（按出图判）时不按客户确认预警', () => {
    expect(judgeW7({ ...drawn, customerPlanDate: d('2026-10-01'), customerConfirmedDate: d('2026-10-10') }, T.W7).level).toBeNull()
    expect(judgeW7({ ...drawn, needsCustomerConfirm: false, customerPlanDate: d('2026-10-01') }, T.W7).level).toBeNull()
    expect(judgeW7({ ...drawn, customerPlanDate: null }, T.W7).level).toBeNull()
    expect(judgeW7({ ...base, needsCustomerConfirm: true, customerPlanDate: d('2026-10-01') }, T.W7)).toMatchObject({ level: null, trigger: null })
  })
  it('待客户确认（已发放）同样判定', () => {
    expect(judgeW7({ ...drawn, status: 'CUSTOMER_PENDING', customerPlanDate: d('2026-10-16') }, T.W7)).toMatchObject({ level: 'YELLOW' })
  })
})

describe('w7Summary', () => {
  const task = { planDate: d('2026-10-16'), customerPlanDate: d('2026-10-13') }
  it('三种触发的文案', () => {
    expect(w7Summary(judgeW7({ ...base, planDate: d('2026-10-16') }, T.W7), task, '张工')).toBe('计划 2026-10-16 完成，已超 1 天仍未出图（张工）')
    expect(w7Summary(judgeW7({ ...base, planDate: d('2026-10-17') }, T.W7), { ...task, planDate: d('2026-10-17') }, '张工')).toBe('计划 2026-10-17 完成，就是今天，仍未出图（张工）')
    const c = judgeW7({ ...base, status: 'DRAWN', drawnDate: d('2026-10-10'), needsCustomerConfirm: true, customerPlanDate: d('2026-10-13') }, T.W7)
    expect(w7Summary(c, task, '张工')).toBe('客户确认计划 2026-10-13，已超 4 天仍未确认（张工）')
  })
})

describe('isOverdue / thisWeek', () => {
  const t = { status: 'PENDING' as const, planDate: d('2026-10-16'), needsCustomerConfirm: false, customerPlanDate: null, customerConfirmedDate: null }
  it('待出图已过计划日；已出图且客户确认已过计划日；当天到期、已完成不算', () => {
    expect(isOverdue(t, NOW)).toBe(true)
    expect(isOverdue({ ...t, planDate: d('2026-10-17') }, NOW)).toBe(false)
    expect(isOverdue({ ...t, status: 'DRAWN' }, NOW)).toBe(false)
    expect(isOverdue({ ...t, status: 'CUSTOMER_PENDING', needsCustomerConfirm: true, customerPlanDate: d('2026-10-16') }, NOW)).toBe(true)
    expect(isOverdue({ ...t, status: 'DONE' }, NOW)).toBe(false)
  })
  it('本周 = 工厂时区周一到周日', () => {
    const w = thisWeek(NOW)
    expect(w.monday.toISOString().slice(0, 10)).toBe('2026-10-12')
    expect(w.sunday.toISOString().slice(0, 10)).toBe('2026-10-18')
    // 周日晚上 23:30（UTC 15:30）仍是本周
    expect(thisWeek(new Date('2026-10-18T15:30:00.000Z')).monday.toISOString().slice(0, 10)).toBe('2026-10-12')
  })
})
