import { afterEach, describe, expect, it, vi } from 'vitest'
import { dayAfter } from '../../app/composables/useFlow'
import { parseDay, todayDay, overdueDays } from '../../server/services/flow/dates'
import { dateFieldDay, dayDiff, shanghaiDay, shanghaiDayStart, elapsedExcludingOffDays } from '../../server/services/alerts/rules'
import { addDays as planAddDays } from '../../server/services/plan/constants'
import { addDays, factoryDay } from '../../shared/mobile-todo'
import * as dates from '../../shared/dates'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('搬移前日期口径钉版（原入口继续作为兼容入口验证）', () => {
  it('原入口与共享入口导出同一函数本体', () => {
    expect(parseDay).toBe(dates.parseDay)
    expect(todayDay).toBe(dates.todayDay)
    expect(overdueDays).toBe(dates.overdueDays)
    expect(factoryDay).toBe(dates.factoryDay)
    expect(addDays).toBe(dates.addDays)
    expect(planAddDays).toBe(dates.addDays)
    expect(shanghaiDay).toBe(dates.shanghaiDay)
    expect(shanghaiDayStart).toBe(dates.shanghaiDayStart)
    expect(dateFieldDay).toBe(dates.dateFieldDay)
    expect(dayDiff).toBe(dates.dayDiff)
    expect(elapsedExcludingOffDays).toBe(dates.elapsedExcludingOffDays)
    expect(dayAfter).toBe(dates.localDayAfter)
  })

  it.each([
    ['2026-12-31T15:59:59.999Z', '2026-12-31', '2026-12-31'],
    ['2026-12-31T16:00:00.000Z', '2026-12-31', '2027-01-01'],
    ['2026-12-31T23:59:59.999Z', '2026-12-31', '2027-01-01'],
    ['2027-01-01T00:00:00.000Z', '2027-01-01', '2027-01-01'],
  ])('%s：UTC 日期字段与上海自然日', (iso, utc, shanghai) => {
    const instant = new Date(iso)
    expect(dateFieldDay(instant)).toBe(utc)
    expect(shanghaiDay(instant)).toBe(shanghai)
    expect(shanghaiDay(+instant)).toBe(shanghai)
    expect(todayDay(instant)).toBe(shanghai)
    expect(factoryDay(instant)).toBe(shanghai)
    expect(factoryDay(iso)).toBe(shanghai)
    expect(parseDay(utc).toISOString()).toBe(`${utc}T00:00:00.000Z`)
  })

  it('Intl 工厂日保留自定义时区、纯日期原样返回及历史夏令时；预警固定 UTC+8', () => {
    expect(factoryDay('2026-12-31', 'America/New_York')).toBe('2026-12-31')
    expect(factoryDay('2027-01-01T00:00:00Z', 'America/New_York')).toBe('2026-12-31')
    const historical = new Date('1990-07-01T15:30:00Z')
    expect(todayDay(historical)).toBe('1990-07-02')
    expect(factoryDay(historical)).toBe('1990-07-02')
    expect(shanghaiDay(historical)).toBe('1990-07-01')
  })

  it.each([
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-12-31', 0, '2026-12-31'],
  ])('日历加天 %s + %i', (day, n, expected) => {
    expect(addDays(day, n)).toBe(expected)
    expect(planAddDays(day, n)).toBe(expected)
    expect(dayDiff(day, expected)).toBe(n)
  })

  it('上海跨零点一毫秒算逾期一天；经过时长仍是一毫秒', () => {
    const from = new Date('2026-12-31T15:59:59.999Z')
    const to = new Date('2026-12-31T16:00:00.000Z')
    expect(overdueDays(parseDay('2026-12-31'), from)).toBe(0)
    expect(overdueDays(parseDay('2026-12-31'), to)).toBe(1)
    expect(overdueDays(null, to)).toBe(0)
    expect(overdueDays(parseDay('2027-01-02'), to)).toBe(0)
    expect(elapsedExcludingOffDays(from, to, [])).toBe(1)
    expect(elapsedExcludingOffDays(from, to, ['2027-01-01'])).toBe(1)
    expect(elapsedExcludingOffDays(from, to, ['2026-12-31'])).toBe(0)
    expect(shanghaiDayStart('2027-01-01')).toBe(+to)
  })

  it.each([-1, 0, 1, 2])('dayAfter 保留经过 %i × 24 小时后取运行环境本地日期', (n) => {
    vi.useFakeTimers().setSystemTime(new Date('2026-12-31T23:30:00Z'))
    const shifted = new Date(Date.now() + n * 86_400_000)
    const expected = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`
    expect(dayAfter(n)).toBe(expected)
  })

  it.each([
    ['UTC', '2026-12-31T16:00:00Z', 0, '2026-12-31'],
    ['Asia/Shanghai', '2026-12-31T16:00:00Z', 0, '2027-01-01'],
    ['America/New_York', '2026-03-08T04:30:00Z', 1, '2026-03-09'],
    ['America/New_York', '2026-11-01T04:30:00Z', 1, '2026-11-01'],
  ] as const)('本地时区 %s 的经过时长口径 %s + %i 天', (tz, now, n, expected) => {
    vi.stubEnv('TZ', tz)
    vi.useFakeTimers().setSystemTime(new Date(now))
    expect(dayAfter(n)).toBe(expected)
    expect(dates.localDayAfter(n, Date.now())).toBe(expected)
  })
})
