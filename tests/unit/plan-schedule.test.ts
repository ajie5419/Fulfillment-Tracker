import { describe, expect, it } from 'vitest'
import { linkSchedule, type ScheduleNode } from '../../server/services/plan/schedule'

const n = (id: string, start: string | null, finish: string, extra: Partial<ScheduleNode> = {}): ScheduleNode => ({ id, name: id, start, finish, parent: null, preds: [], done: false, ...extra })
const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}`

describe('planned date dependency cascade', () => {
  it('preserves duration and propagates transitively, without moving unrelated branches', () => {
    const r = linkSchedule([n('a', day(1), day(10)), n('b', day(5), day(8), { preds: ['a'] }), n('c', day(9), day(10), { preds: ['b'] }), n('other', day(2), day(3))], 'a')
    expect(r.nodes.map((x) => [x.id, x.start, x.finish])).toEqual([
      ['a', day(1), day(10)], ['b', day(11), day(14)], ['c', day(15), day(16)], ['other', day(2), day(3)],
    ])
  })
  it('consumes slack, takes the latest predecessor and never pulls dates earlier', () => {
    const rows = [n('a', day(1), day(5)), n('b', day(1), day(12)), n('c', day(10), day(11), { preds: ['a', 'b'] })]
    expect(linkSchedule(rows, 'a').nodes[2]).toMatchObject({ start: day(13), finish: day(14) })
    rows[1]!.finish = day(7)
    expect(linkSchedule(rows, 'a').nodes[2]).toMatchObject({ start: day(10), finish: day(11) })
  })
  it('stops at completed nodes and retains missing starts as milestones', () => {
    const r = linkSchedule([n('a', day(1), day(10)), n('b', day(5), day(6), { preds: ['a'], done: true }), n('c', day(7), day(8), { preds: ['b'] }), n('m', null, day(5), { preds: ['a'] })], 'a')
    expect(r.skipped).toEqual(['b'])
    expect(r.nodes[1]!.finish).toBe(day(6))
    expect(r.nodes[2]!.start).toBe(day(7))
    expect(r.nodes[3]).toMatchObject({ start: null, finish: day(11) })
  })
  it('rolls child dates into summaries and cascades from the summary', () => {
    const r = linkSchedule([n('parent', day(1), day(3)), n('a', day(2), day(12), { parent: 'parent' }), n('b', day(1), day(3), { parent: 'parent' }), n('c', day(4), day(5), { preds: ['parent'] })], 'a')
    expect(r.nodes[0]).toMatchObject({ start: day(1), finish: day(12) })
    expect(r.nodes[3]).toMatchObject({ start: day(13), finish: day(14) })
  })
  it('honors default top-level dependencies but not implicit sibling dependencies', () => {
    const r = linkSchedule([n('a', null, day(10), { preds: null }), n('b', day(2), day(4), { preds: null })], 'a')
    expect(r.nodes[1]).toMatchObject({ start: day(11), finish: day(13) })
  })
  it('rejects cycles instead of partially scheduling', () => {
    expect(() => linkSchedule([n('a', null, day(1), { preds: ['b'] }), n('b', null, day(2), { preds: ['a'] })], 'a')).toThrow('循环')
  })
})
