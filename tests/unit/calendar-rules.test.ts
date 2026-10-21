/** 项目日历（zhao 10-21）：周 / 月的起止、翻页、格子天数；按发运节点统计计划 / 实际 / 逾期台数；没有总计划的按 QMS 交期计入 */
import { describe, expect, it } from 'vitest'
import { stableDoneDay } from '../../server/services/calendar/rules'
import { type CompletionLike, completionState, gridDays, periodOf, shiftPeriod, summarize } from '../../shared/calendar'

describe('periodOf / shiftPeriod', () => {
  it('周一到周日算一周（周日属于前一周）', () => {
    expect(periodOf('week', '2026-10-21')).toMatchObject({ start: '2026-10-19', end: '2026-10-25', label: '10/19–10/25' })
    expect(periodOf('week', '2026-10-25').start).toBe('2026-10-19')
    expect(periodOf('week', '2026-10-26').start).toBe('2026-10-26')
  })
  it('月：1 号到月底，含闰年 2 月', () => {
    expect(periodOf('month', '2026-10-21')).toMatchObject({ start: '2026-10-01', end: '2026-10-31', label: '10月' })
    expect(periodOf('month', '2028-02-10').end).toBe('2028-02-29')
    expect(periodOf('month', '2026-02-10').end).toBe('2026-02-28')
  })
  it('翻页跨年', () => {
    expect(shiftPeriod(periodOf('month', '2026-12-05'), 1).start).toBe('2027-01-01')
    expect(shiftPeriod(periodOf('month', '2026-01-31'), -1).start).toBe('2025-12-01')
    expect(shiftPeriod(periodOf('week', '2026-12-30'), 1)).toMatchObject({ start: '2027-01-04', end: '2027-01-10' })
  })
  it('月历格子从第一天所在周的周一到最后一天所在周的周日；周视图 7 天', () => {
    const days = gridDays(periodOf('month', '2026-10-01'))
    expect(days[0]).toBe('2026-09-28')
    expect(days.at(-1)).toBe('2026-11-01')
    expect(days.length % 7).toBe(0)
    expect(gridDays(periodOf('week', '2026-10-21'))).toHaveLength(7)
  })
})

describe('summarize：按发运节点统计台数', () => {
  const today = '2026-10-21'
  const oct = periodOf('month', today)
  const c = (x: Partial<CompletionLike>): CompletionLike => ({ quantity: 1, planDay: '2026-10-25', source: 'PLAN', done: false, actualDay: null, ...x })

  it('计划按计划完成日、实际按完成日分别计入（提前 / 推迟完成的计到实际完成那一期）', () => {
    const items = [
      c({ quantity: 2, planDay: '2026-10-10', done: true, actualDay: '2026-10-12' }),
      c({ quantity: 1, planDay: '2026-11-05', done: true, actualDay: '2026-10-30' }), // 提前到 10 月完成
      c({ quantity: 3, planDay: '2026-10-28' }),
    ]
    const s = summarize(items, oct, today)
    expect(s.planned).toEqual({ orders: 2, units: 5 })
    expect(s.actual).toEqual({ orders: 2, units: 3 })
    expect(summarize(items, periodOf('month', '2026-11-01'), today).planned).toEqual({ orders: 1, units: 1 })
    expect(summarize(items, periodOf('month', '2026-11-01'), today).actual).toEqual({ orders: 0, units: 0 })
  })

  it('逾期未完成：计划日早于今天、没完成；今天到期的不算逾期', () => {
    const s = summarize([c({ planDay: '2026-10-20', quantity: 2 }), c({ planDay: today }), c({ planDay: '2026-10-05', done: true, actualDay: '2026-10-06' })], oct, today)
    expect(s.overdue).toEqual({ orders: 1, units: 2 })
  })

  it('没有已发布总计划：按 QMS 交期计入计划、单列"未排总计划"，不判逾期、不计实际', () => {
    const s = summarize([c({ source: 'DELIVERY', planDay: '2026-10-02', quantity: 4 })], oct, today)
    expect(s.planned).toEqual({ orders: 1, units: 4 })
    expect(s.noPlan).toEqual({ orders: 1, units: 4 })
    expect(s.overdue.orders).toBe(0)
    expect(s.actual.orders).toBe(0)
  })

  it('QMS 数量为 0：计工单数、不计台数，并提示缺数量', () => {
    const s = summarize([c({ quantity: 0 }), c({ quantity: -1 })], oct, today)
    expect(s.planned).toEqual({ orders: 2, units: 0 })
    expect(s.missingQuantity).toBe(2)
  })

  it('完成状态', () => {
    expect(completionState({ source: 'DELIVERY', done: false, planDay: '2026-10-01' }, today)).toBe('NO_PLAN')
    expect(completionState({ source: 'PLAN', done: true, planDay: '2026-10-01' }, today)).toBe('DONE')
    expect(completionState({ source: 'PLAN', done: false, planDay: '2026-10-20' }, today)).toBe('OVERDUE')
    expect(completionState({ source: 'PLAN', done: false, planDay: today }, today)).toBe('PENDING')
  })
})

describe('stableDoneDay：实际完成日只认落库的日期', () => {
  const t = (kind: 'drawing' | 'purchase' | 'step' | 'assembly', doneDay: string | null, excluded = false) => ({ kind, doneDay, excluded })
  it('没完成 → null；手动标记 → 手动填的日期', () => {
    expect(stableDoneDay({ done: false, doneBy: null, actualDay: null }, [])).toBeNull()
    expect(stableDoneDay({ done: true, doneBy: 'MANUAL', actualDay: '2026-10-15' }, [t('assembly', '2026-10-21')])).toBe('2026-10-15')
  })
  it('自动完成：取任务记录的完成日里最晚的（已取消的不算）', () => {
    expect(stableDoneDay({ done: true, doneBy: 'AUTO', actualDay: '2026-10-21' }, [t('purchase', '2026-10-10'), t('step', '2026-10-12'), t('drawing', null, true)])).toBe('2026-10-12')
  })
  it('自动完成但挂了装配节点、或有任务没记完成日 → null（不随日子挪）', () => {
    expect(stableDoneDay({ done: true, doneBy: 'AUTO', actualDay: '2026-10-21' }, [t('purchase', '2026-10-10'), t('assembly', '2026-10-21')])).toBeNull()
    expect(stableDoneDay({ done: true, doneBy: 'AUTO', actualDay: '2026-10-21' }, [t('step', null)])).toBeNull()
  })
  it('已完成但没有完成日：不计实际、不算逾期', () => {
    const s = summarize([{ quantity: 2, planDay: '2026-10-10', source: 'PLAN', done: true, actualDay: null }], periodOf('month', '2026-10-21'), '2026-10-21')
    expect(s.actual.orders).toBe(0)
    expect(s.overdue.orders).toBe(0)
    expect(completionState({ source: 'PLAN', done: true, planDay: '2026-10-10' }, '2026-10-21')).toBe('DONE')
  })
})
