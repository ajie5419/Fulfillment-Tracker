import { describe, expect, it } from 'vitest'
import { addDays } from '../../shared/dates'
import { estimateNodes } from '../../server/services/plan/node-estimates'
import type { NodeFacts } from '../../server/services/plan/estimate-types'

const today = '2026-10-30'
const node = (id: string, startDay: string | null, planDay: string, preds: string[] = [], parent?: string): NodeFacts => ({ id, startDay, planDay, preds, parent, manualDoneDay: null, tasks: [] })

describe('停工日下的后向余量', () => {
  it.each([
    { name: '审查示例：11-06 停工，A 只能从 11-01 拖到 11-04', off: ['2026-11-06'], finish: '2026-11-04', delivery: '2026-11-07', slack: 3 },
    { name: '连续停工跨过最晚开始日', off: ['2026-11-05', '2026-11-06'], finish: '2026-11-04', delivery: '2026-11-07', slack: 2 },
    { name: '停工在自然日工期内不扣工期', off: ['2026-11-06'], finish: '2026-11-07', delivery: '2026-11-09', slack: 3 },
    { name: '交期已晚时也按工厂日历反推负余量', off: ['2026-11-04', '2026-11-05'], finish: '2026-11-04', delivery: '2026-11-05', slack: -3, expectedA: '2026-11-05' },
  ])('$name', ({ off, finish, delivery, slack, expectedA = '2026-11-01' }) => {
    const input = [node('A', null, '2026-11-01'), node('B', '2026-11-03', finish, ['A'])]
    input[0]!.tasks = [{ id: 'task', kind: 'task', excluded: false, done: false, doneDay: null, planDay: expectedA }]
    const calendar = new Set(off)
    const estimates = estimateNodes(input, today, delivery, calendar)
    expect(estimates[0]?.slackDays).toBe(slack)
    // Decomposed nodes finish through their tasks; manual marks cannot override active work.
    const shifted = (days: number) => estimateNodes([
      { ...input[0]!, tasks: input[0]!.tasks.map(task => ({ ...task, done: true, doneDay: addDays(expectedA, days) })) },
      input[1]!,
    ], today, delivery, calendar)[1]!.expectedDay
    expect(shifted(slack) <= delivery).toBe(true)
    expect(shifted(slack + 1) > delivery).toBe(true)
  })

  it('无开始日的兼容分支同时满足原间隔和次一工厂工作日', () => {
    const input = [node('A', null, '2026-11-01'), node('B', null, '2026-11-02', ['A'])]
    const calendar = new Set(['2026-11-06', '2026-11-07'])
    expect(estimateNodes(input, today, '2026-11-07', calendar)[0]?.slackDays).toBe(3)
    const shifted = estimateNodes([{ ...input[0]!, manualDoneDay: '2026-11-04' }, input[1]!], today, '2026-11-07', calendar)
    expect(shifted[1]?.expectedDay).toBe('2026-11-05')
  })

  it('多后续取更紧的工厂日历约束，子节点到汇总行不额外加 FS 间隔', () => {
    const input = [
      node('P', null, '2026-11-01'),
      node('A', null, '2026-11-01', [], 'P'),
      node('B', '2026-11-03', '2026-11-04', ['P']),
      node('C', '2026-11-02', '2026-11-05', ['P']),
      node('交付', '2026-11-06', '2026-11-06', ['B', 'C']),
    ]
    const calendar = new Set(['2026-11-06'])
    const estimates = estimateNodes(input, today, '2026-11-09', calendar)
    expect(estimates.find((entry) => entry.id === 'P')?.slackDays).toBe(3)
    expect(estimates.find((entry) => entry.id === 'A')?.slackDays).toBe(3)
    const shifted = estimateNodes(input.map((entry) => entry.id === 'A' ? { ...entry, manualDoneDay: '2026-11-04' } : entry), today, '2026-11-09', calendar)
    expect(shifted.at(-1)?.expectedDay).toBe('2026-11-09')
  })
})
