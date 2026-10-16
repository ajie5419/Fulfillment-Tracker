/** 预警规则判定（纯函数）：停工日计时、W1–W3 阈值边界、只升不降 */
import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  DEFAULT_THRESHOLDS as T,
  HOUR_MS,
  elapsedExcludingOffDays,
  judgeW3,
  levelByElapsed,
  maxLevel,
  reminderTitle,
  shanghaiDay,
} from '../../server/services/alerts/rules'

/** 北京时间 → Date */
const bj = (s: string) => new Date(`${s}+08:00`)
const day = (d: string) => new Date(`${d}T00:00:00.000Z`) // 日期字段的存法

describe('elapsedExcludingOffDays', () => {
  it('没有停工日时就是两者之差；倒序为 0', () => {
    expect(elapsedExcludingOffDays(bj('2026-10-08T10:00:00'), bj('2026-10-10T10:00:00'), [])).toBe(2 * DAY_MS)
    expect(elapsedExcludingOffDays(bj('2026-10-10T10:00:00'), bj('2026-10-08T10:00:00'), [])).toBe(0)
  })

  it('跨停工日：中间的停工日整天不计', () => {
    // 9-30 10:00 → 10-08 10:00 共 8 天，国庆 10-01 ~ 10-07 停工 7 天 → 1 天
    const off = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
    expect(elapsedExcludingOffDays(bj('2026-09-30T10:00:00'), bj('2026-10-08T10:00:00'), off)).toBe(DAY_MS)
  })

  it('起点落在停工日：从停工日结束（次日 0 点）开始算', () => {
    // Q12：10-01 返厂，10-01 是停工日 → 从 10-02 00:00 起算
    expect(elapsedExcludingOffDays(bj('2026-10-01T15:00:00'), bj('2026-10-03T06:00:00'), ['2026-10-01'])).toBe(30 * HOUR_MS)
  })

  it('终点落在停工日：停工日里的时间不计', () => {
    expect(elapsedExcludingOffDays(bj('2026-10-01T12:00:00'), bj('2026-10-02T20:00:00'), ['2026-10-02'])).toBe(12 * HOUR_MS)
  })

  it('起止都在同一个停工日内为 0；重复的停工日只扣一次', () => {
    expect(elapsedExcludingOffDays(bj('2026-10-01T08:00:00'), bj('2026-10-01T20:00:00'), ['2026-10-01'])).toBe(0)
    expect(elapsedExcludingOffDays(bj('2026-09-30T00:00:00'), bj('2026-10-03T00:00:00'), ['2026-10-01', '2026-10-01'])).toBe(2 * DAY_MS)
  })

  it('时区边界：停工日按北京时间的整天，不是 UTC 的整天', () => {
    // 北京 10-01 00:00 = UTC 09-30 16:00。UTC 09-30 16:00 → 24:00 这段属于北京 10-01，要扣
    const from = new Date('2026-09-30T12:00:00Z') // 北京 09-30 20:00
    const to = new Date('2026-09-30T23:00:00Z') // 北京 10-01 07:00
    expect(elapsedExcludingOffDays(from, to, ['2026-10-01'])).toBe(4 * HOUR_MS) // 只剩北京 09-30 20:00 → 24:00
    expect(elapsedExcludingOffDays(from, to, ['2026-09-30'])).toBe(7 * HOUR_MS) // 只剩北京 10-01 00:00 → 07:00
    expect(shanghaiDay(new Date('2026-09-30T16:00:00Z'))).toBe('2026-10-01')
    expect(shanghaiDay(new Date('2026-09-30T15:59:59Z'))).toBe('2026-09-30')
  })

  it('与区间不相交的停工日不影响', () => {
    expect(elapsedExcludingOffDays(bj('2026-10-08T00:00:00'), bj('2026-10-09T00:00:00'), ['2026-10-01', '2026-10-10'])).toBe(DAY_MS)
  })
})

describe('W1 待确认匹配超时（提醒 4 小时 / 黄 1 天 / 红 3 天）', () => {
  it.each([
    [4 * HOUR_MS - 1, null],
    [4 * HOUR_MS, 'REMIND'],
    [DAY_MS - 1, 'REMIND'],
    [DAY_MS, 'YELLOW'],
    [3 * DAY_MS - 1, 'YELLOW'],
    [3 * DAY_MS, 'RED'],
  ])('%i ms → %s', (ms, level) => {
    expect(levelByElapsed(ms, T.W1)).toBe(level)
  })
})

describe('W2 转序停滞（黄 2 天 / 红 4 天，无提醒）', () => {
  it.each([
    [DAY_MS * 2 - 1, null],
    [DAY_MS * 2, 'YELLOW'],
    [DAY_MS * 4 - 1, 'YELLOW'],
    [DAY_MS * 4, 'RED'],
  ])('%i ms → %s', (ms, level) => {
    expect(levelByElapsed(ms, T.W2)).toBe(level)
  })
  it('很久也不会出"提醒"一级', () => {
    expect(levelByElapsed(DAY_MS, T.W2)).toBeNull()
  })
})

describe('W3 外协逾期未返（到期前 2 天提醒 / 超期 1 天黄 / 超期 3 天红）', () => {
  const w3 = (promised: string, now: string, opts: { due?: string; off?: string[] } = {}) =>
    judgeW3({ promisedReturnDate: day(promised), dueDate: opts.due ? day(opts.due) : null, now: bj(now), offDays: opts.off ?? [] }, T.W3)

  it('到期前 3 天无预警，前 2 天起提醒，当天仍是提醒', () => {
    expect(w3('2026-10-20', '2026-10-17T23:59:59').level).toBeNull()
    expect(w3('2026-10-20', '2026-10-18T00:00:00')).toMatchObject({ level: 'REMIND', daysLeft: 2 })
    expect(w3('2026-10-20', '2026-10-20T23:59:59')).toMatchObject({ level: 'REMIND', daysLeft: 0, overdueDays: 0 })
  })

  it('超期 1 天黄，超期 3 天红（按北京时间的日界）', () => {
    expect(w3('2026-10-20', '2026-10-21T00:00:00')).toMatchObject({ level: 'YELLOW', overdueDays: 1 })
    expect(w3('2026-10-20', '2026-10-22T23:59:59')).toMatchObject({ level: 'YELLOW', overdueDays: 2 })
    expect(w3('2026-10-20', '2026-10-23T00:00:00')).toMatchObject({ level: 'RED', overdueDays: 3 })
    // UTC 10-20 16:00 已是北京 10-21
    const r = judgeW3({ promisedReturnDate: day('2026-10-20'), dueDate: null, now: new Date('2026-10-20T16:00:00Z'), offDays: [] }, T.W3)
    expect(r).toMatchObject({ level: 'YELLOW', overdueDays: 1 })
  })

  it('要求完成日已过直接红，哪怕还没到承诺返回日', () => {
    expect(w3('2026-10-30', '2026-10-21T09:00:00', { due: '2026-10-20' })).toMatchObject({ level: 'RED', dueDatePassed: true })
    expect(w3('2026-10-30', '2026-10-20T23:00:00', { due: '2026-10-20' })).toMatchObject({ level: null, dueDatePassed: false }) // 当天不算已过
  })

  it('停工日不计入超期天数，但不屏蔽到期前提醒', () => {
    // 承诺 09-30，国庆 10-01 ~ 10-07 停工：10-08 才算超期 1 天
    const off = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
    expect(w3('2026-09-30', '2026-10-05T10:00:00', { off })).toMatchObject({ level: 'REMIND', overdueDays: 0 })
    expect(w3('2026-09-30', '2026-10-08T10:00:00', { off })).toMatchObject({ level: 'YELLOW', overdueDays: 1 })
    expect(w3('2026-10-02', '2026-09-30T10:00:00', { off })).toMatchObject({ level: 'REMIND', daysLeft: 2 })
  })
})

describe('只升不降', () => {
  it('取较高的级别，null 不会把已有级别抹掉', () => {
    expect(maxLevel('YELLOW', 'REMIND')).toBe('YELLOW')
    expect(maxLevel('YELLOW', null)).toBe('YELLOW')
    expect(maxLevel('REMIND', 'RED')).toBe('RED')
    expect(maxLevel(null, 'REMIND')).toBe('REMIND')
    expect(maxLevel(null, null)).toBeNull()
  })

  it('阈值调大后判定变低，但与已有级别合并后仍是黄', () => {
    const bigger = { remindHours: 4, yellowDays: 5, redDays: 9 }
    const computed = levelByElapsed(2 * DAY_MS, bigger)
    expect(computed).toBe('REMIND')
    expect(maxLevel('YELLOW', computed)).toBe('YELLOW')
  })
})

it('提醒标题一眼能看懂', () => {
  expect(reminderTitle('YELLOW', '主梁结构件 · 涂装', '组焊返厂 2 天仍未发出', 'DEMO-WO-001')).toBe('【黄】主梁结构件 · 涂装：组焊返厂 2 天仍未发出（DEMO-WO-001）')
  expect(reminderTitle('REMIND', 'x', 'y', null)).toBe('【提醒】x：y')
})
