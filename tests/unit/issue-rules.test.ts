/** W4 异常超期判定与异常编号、默认要求解决日（纯函数） */
import { describe, expect, it } from 'vitest'
import { DAY_MS, DEFAULT_THRESHOLDS as T, HOUR_MS, judgeW4, overdueDaysExcludingOffDays } from '../../server/services/alerts/rules'
import { DEFAULT_DEPT_NAME, defaultDueDate, formatIssueNo, issueNoPrefix, nextSeq } from '../../server/services/issues/constants'

/** 北京时间 → Date */
const bj = (s: string) => new Date(`${s}+08:00`)
const day = (d: string) => new Date(`${d}T00:00:00.000Z`) // 日期字段的存法

describe('judgeW4', () => {
  const base = { createdAt: bj('2026-10-12T10:00:00'), dueDate: null, offDays: [] as string[] }

  it('默认阈值：待受理/超期 1 天黄，超期 3 天红，没有提醒一级', () => {
    expect(T.W4).toEqual({ remindHours: null, yellowDays: 1, redDays: 3 })
  })

  it('待受理：满 1 天（不含停工日）黄；差 1 秒不预警；待受理再久也只是黄', () => {
    expect(judgeW4({ ...base, status: 'OPEN', now: bj('2026-10-13T09:59:59') }, T.W4).level).toBeNull()
    expect(judgeW4({ ...base, status: 'OPEN', now: bj('2026-10-13T10:00:00') }, T.W4)).toMatchObject({ level: 'YELLOW', watched: true, openMs: DAY_MS })
    expect(judgeW4({ ...base, status: 'OPEN', now: bj('2026-10-20T10:00:00') }, T.W4).level).toBe('YELLOW')
    // 中间一天停工：不计
    const r = judgeW4({ ...base, status: 'OPEN', now: bj('2026-10-14T09:00:00'), offDays: ['2026-10-13'] }, T.W4)
    expect(r.level).toBeNull()
    expect(r.openMs).toBe(14 * HOUR_MS + 9 * HOUR_MS)
  })

  it('处理中：不看待受理时长，只看要求解决日；当天到期不算超期', () => {
    const due = day('2026-10-15')
    const at = (s: string) => judgeW4({ ...base, status: 'ACCEPTED', dueDate: due, now: bj(s) }, T.W4)
    expect(at('2026-10-15T23:59:59')).toMatchObject({ level: null, overdueDays: 0, openMs: 0 })
    expect(at('2026-10-16T00:00:00')).toMatchObject({ level: 'YELLOW', overdueDays: 1 })
    expect(at('2026-10-17T12:00:00')).toMatchObject({ level: 'YELLOW', overdueDays: 2 })
    expect(at('2026-10-18T00:00:00')).toMatchObject({ level: 'RED', overdueDays: 3 })
    // 没有要求解决日的处理中：不预警
    expect(judgeW4({ ...base, status: 'ACCEPTED', now: bj('2026-11-30T00:00:00') }, T.W4).level).toBeNull()
  })

  it('待受理且已过要求解决日：取较高的级别', () => {
    const r = judgeW4({ ...base, status: 'OPEN', dueDate: day('2026-10-12'), now: bj('2026-10-15T08:00:00') }, T.W4)
    expect(r).toMatchObject({ level: 'RED', overdueDays: 3 })
  })

  it('超期天数扣停工日', () => {
    const r = judgeW4({ ...base, status: 'ACCEPTED', dueDate: day('2026-09-30'), now: bj('2026-10-08T09:00:00'), offDays: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'] }, T.W4)
    expect(r).toMatchObject({ level: 'YELLOW', overdueDays: 1 })
    expect(overdueDaysExcludingOffDays(day('2026-09-30'), bj('2026-10-08T09:00:00'), [])).toBe(8)
  })

  it('待确认、已关闭：不关注（消除）', () => {
    for (const status of ['RESOLVED', 'CLOSED'] as const) {
      expect(judgeW4({ ...base, status, dueDate: day('2026-01-01'), now: bj('2026-10-20T00:00:00') }, T.W4)).toEqual({ level: null, watched: false, openMs: 0, overdueDays: 0 })
    }
  })

  it('阈值可调', () => {
    const t = { remindHours: null, yellowDays: 2, redDays: 5 }
    expect(judgeW4({ ...base, status: 'OPEN', now: bj('2026-10-13T12:00:00') }, t).level).toBeNull()
    expect(judgeW4({ ...base, status: 'ACCEPTED', dueDate: day('2026-10-10'), now: bj('2026-10-14T12:00:00') }, t).level).toBe('YELLOW')
    expect(judgeW4({ ...base, status: 'ACCEPTED', dueDate: day('2026-10-10'), now: bj('2026-10-15T12:00:00') }, t).level).toBe('RED')
  })
})

describe('异常编号与默认值', () => {
  it('编号按工厂时区日期：YC-YYMMDD-NNN', () => {
    expect(issueNoPrefix(bj('2026-10-16T23:59:00'))).toBe('YC-261016-')
    expect(issueNoPrefix(bj('2026-10-17T00:01:00'))).toBe('YC-261017-') // UTC 还是 16 号
    expect(formatIssueNo('YC-261016-', 7)).toBe('YC-261016-007')
    expect(nextSeq('YC-261016-', null)).toBe(1)
    expect(nextSeq('YC-261016-', 'YC-261016-041')).toBe(42)
    expect(nextSeq('YC-261016-', 'YC-261015-099')).toBe(1)
  })

  it('默认要求解决日 = 受理当天（工厂时区）+ 3 天', () => {
    expect(defaultDueDate(bj('2026-10-16T23:30:00'))).toEqual(day('2026-10-19'))
    expect(defaultDueDate(bj('2026-10-17T00:30:00'))).toEqual(day('2026-10-20'))
  })

  it('分类默认责任部门（方案 6.4）', () => {
    expect(DEFAULT_DEPT_NAME).toMatchObject({
      DESIGN: '技术部', CHANGE: '技术部', MATERIAL_PAYMENT: '财务部', MATERIAL_MGMT: '采购部',
      OUTSOURCE_SCHEDULE: '生产部', OUTSOURCE_QUALITY: '质量部', WORKSHOP: '生产部', CUSTOMER: '项目部', OTHER: '项目部',
    })
  })
})
