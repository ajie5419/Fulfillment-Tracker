import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { dateFieldDay } from '../../server/services/alerts/rules'
import { FlowError } from '../../server/services/flow/errors'
import { pureDeclarations } from '../helpers/pure-declarations'
import * as validation from '../../shared/plan-validation'

const server = () => pureDeclarations('server/services/plan/commands.ts', ['startCheck', 'needReason'], { day: dateFieldDay, FlowError, ...validation })
const editor = (published: boolean, editing: { planDate: string } | null, planDate?: string, startDate?: string) => pureDeclarations(
  'app/components/PlanEditor.vue', ['startLate', 'needReason'], {
    ...validation, computed: (fn: () => boolean) => fn(), published: { value: published }, editing: { value: editing },
    form: { planDate: planDate ? dayjs(planDate) : undefined, startDate: startDate ? dayjs(startDate) : undefined },
  },
)

describe('计划校验搬移前现状：真实服务私有校验 / 编辑器 computed', () => {
  it('编辑器未选完成日、无效 Dayjs 都沿用 isAfter 的 false 结果', () => {
    expect(editor(false, null, undefined, '2026-12-31').startLate).toBe(false)
    expect(editor(false, null, '2026-12-31', 'invalid').startLate).toBe(false)
    expect(editor(false, null, 'invalid', '2026-12-31').startLate).toBe(false)
  })
  it.each([
    [undefined, '2026-12-31', false],
    ['2026-12-30', '2026-12-31', false],
    ['2026-12-31', '2026-12-31', false],
    ['2027-01-01', '2026-12-31', true],
  ] as const)('开始 %s 完成 %s', (start, plan, invalid) => {
    expect(editor(false, null, plan, start).startLate).toBe(invalid)
    expect(validation.isPlanStartLate(start, plan)).toBe(invalid)
    const check = () => server().startCheck(start ? new Date(`${start}T23:00:00Z`) : null, new Date(`${plan}T00:00:00Z`))
    if (invalid) expect(check).toThrow(`计划开始日 ${start} 不能晚于计划完成日 ${plan}`)
    else expect(check).not.toThrow()
  })

  it.each([
    [false, null, '2026-12-31', false],
    [true, null, '2026-12-31', true],
    [true, { planDate: '2026-12-31' }, '2026-12-31', false],
    [true, { planDate: '2026-12-31' }, '2027-01-01', true],
    [true, { planDate: '2026-12-31' }, undefined, false],
  ] as const)('发布 %s 编辑 %j 日期 %s', (published, old, plan, required) => {
    expect(editor(published, old, plan).needReason).toBe(required)
    expect(validation.planAdjustmentNeedsReason(published, old?.planDate ?? null, plan)).toBe(required)
    const action = old ? '改计划日期' : '加节点'
    for (const reason of [undefined, null, '', '  ', '原因']) {
      expect(validation.isPlanAdjustmentReasonMissing(required, reason)).toBe(required && !reason?.trim())
      // updateNode 只在完成日变化时调用 needReason；开始日、部门等变化不要求原因。
      const check = () => { if (!old || (plan !== undefined && plan !== old.planDate)) server().needReason(published, reason, action) }
      if (required && !reason?.trim()) expect(check).toThrow(`总计划已发布，${action}要写调整原因`)
      else expect(check).not.toThrow()
    }
  })

  it('删除已发布节点也要求原因，草稿删除不要求；保持原中文提示', () => {
    expect(() => server().needReason(true, ' ', '删节点')).toThrow('总计划已发布，删节点要写调整原因')
    expect(() => server().needReason(false, null, '删节点')).not.toThrow()
  })
})
