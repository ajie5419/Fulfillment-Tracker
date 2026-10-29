/** 工艺模块（10-27）：料单 / 工艺允许的状态变化 */
import { describe, expect, it } from 'vitest'
import { allowedActions, nextStatus, processSummary } from '../../server/services/process/constants'
import { processReleaseBlockReason } from '../../shared/process'

describe('料单状态', () => {
  it('未开始 → 编制中 → 已下发 → 修改中 → 已下发', () => {
    expect(nextStatus('MATERIAL', 'NOT_STARTED', 'start')).toBe('DRAFTING')
    expect(nextStatus('MATERIAL', 'DRAFTING', 'issue')).toBe('ISSUED')
    expect(nextStatus('MATERIAL', 'ISSUED', 'revise')).toBe('REVISING')
    expect(nextStatus('MATERIAL', 'REVISING', 'issue')).toBe('ISSUED')
  })
  it('不允许跳步、重复下发；编制中可以撤回到未开始，修改中不能撤回', () => {
    expect(nextStatus('MATERIAL', 'NOT_STARTED', 'issue')).toBeNull()
    expect(nextStatus('MATERIAL', 'ISSUED', 'issue')).toBeNull()
    expect(nextStatus('MATERIAL', 'DRAFTING', 'reset')).toBe('NOT_STARTED')
    expect(nextStatus('MATERIAL', 'REVISING', 'reset')).toBeNull()
    expect(allowedActions('MATERIAL', 'NOT_STARTED')).toEqual(['start'])
    expect(allowedActions('MATERIAL', 'DRAFTING')).toEqual(['issue', 'reset'])
    expect(allowedActions('MATERIAL', 'REVISING')).toEqual(['issue'])
    expect(allowedActions('MATERIAL', 'ISSUED')).toEqual(['revise'])
  })
})

describe('图纸正式发放前置', () => {
  it.each([
    ['MATERIAL', 'start', '图纸未发放，不能开始编制料单'],
    ['MATERIAL', 'issue', '图纸未发放，不能下发料单'],
    ['PROCESS', 'start', '图纸未发放，不能开始编制工艺'],
    ['PROCESS', 'issue', '图纸未发放，不能下发工艺'],
  ] as const)('%s/%s 未发放时明确说明原因，有效发放后放行', (kind, action, reason) => {
    expect(processReleaseBlockReason(kind, action, false)).toBe(reason)
    expect(processReleaseBlockReason(kind, action, true)).toBeNull()
  })

  it.each([
    ['MATERIAL', 'revise'], ['MATERIAL', 'reset'], ['PROCESS', 'revise'], ['PROCESS', 'reset'],
  ] as const)('%s/%s 是回退，未发放也允许（包括工艺退回编制中）', (kind, action) => {
    expect(processReleaseBlockReason(kind, action, false)).toBeNull()
  })

  it('作废回退的工艺修改中可以重新下发，不能重新开始或撤回', () => {
    expect(nextStatus('PROCESS', 'REVISING', 'issue')).toBe('ISSUED')
    expect(allowedActions('PROCESS', 'REVISING')).toEqual(['issue'])
    expect(processSummary({ materialStatus: 'ISSUED', processStatus: 'REVISING' })).toBe('料单已下发 · 工艺修改中')
  })
})

describe('工艺状态', () => {
  it('无 → 编制中 → 已下发；修改回到编制中', () => {
    expect(nextStatus('PROCESS', 'NONE', 'start')).toBe('DRAFTING')
    expect(nextStatus('PROCESS', 'DRAFTING', 'issue')).toBe('ISSUED')
    expect(nextStatus('PROCESS', 'ISSUED', 'revise')).toBe('DRAFTING')
    expect(nextStatus('PROCESS', 'DRAFTING', 'reset')).toBe('NONE')
    expect(nextStatus('PROCESS', 'NONE', 'issue')).toBeNull()
    expect(allowedActions('PROCESS', 'ISSUED')).toEqual(['revise'])
  })
  it('一句话摘要', () => {
    expect(processSummary({ materialStatus: 'REVISING', processStatus: 'NONE' })).toBe('料单修改中 · 工艺无')
  })
})
