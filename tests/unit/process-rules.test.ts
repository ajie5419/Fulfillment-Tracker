/** 工艺模块（10-27）：料单 / 工艺允许的状态变化 */
import { describe, expect, it } from 'vitest'
import { allowedActions, nextStatus, processSummary } from '../../server/services/process/constants'

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
