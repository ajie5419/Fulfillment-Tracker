import { expect, it } from 'vitest'
import { drawingPresentation } from '../../shared/drawing'
const base = { status: 'PENDING', planDate: '2026-11-11', drawnDate: null, released: false, needsCustomerConfirm: true, customerPlanDate: '2026-11-12', customerConfirmedDate: null, alertLevel: 'YELLOW' }
it('separates a design warning from a future customer deadline', () => {
  expect(drawingPresentation(base, '2026-11-10')).toMatchObject({ designText: '设计中', designWarning: '设计明日到期', customerText: '待客户确认 · 计划 11-12', customerOverdue: false })
})
it('keeps confirmation visible before and after releasing drawings', () => {
  for (const released of [false, true]) expect(drawingPresentation({ ...base, status: 'DRAWN', drawnDate: '2026-11-10', customerConfirmedDate: '2026-11-11', released }, '2026-11-15')).toMatchObject({ designText: `设计完成 · ${released ? '已发放' : '待发放'}`, designWarning: null, customerText: '已确认 · 11-11', customerOverdue: false })
})
it('shows a missed confirmation deadline and treats the due date itself as on time', () => {
  expect(drawingPresentation(base, '2026-11-12').customerOverdue).toBe(false)
  expect(drawingPresentation(base, '2026-11-14')).toMatchObject({ customerText: '客户确认逾期 2 天', customerOverdue: true })
})
it('handles unspecified dates, unnecessary confirmation and cancellation', () => {
  expect(drawingPresentation({ ...base, customerPlanDate: null }, '2026-11-14').customerText).toBe('待客户确认 · 日期未定')
  expect(drawingPresentation({ ...base, needsCustomerConfirm: false }, '2026-11-14').customerText).toBeNull()
  expect(drawingPresentation({ ...base, status: 'CANCELLED' }, '2026-11-14')).toMatchObject({ designText: '已取消', designWarning: null, customerText: null })
})
