/** 发放签收（R9）的纯函数：按"部门 + 角色"选人、设计变更影响的工序、编号、W5 阈值 */
import { describe, expect, it } from 'vitest'
import { DAY_MS, DEFAULT_THRESHOLDS as T, HOUR_MS, levelByElapsed } from '../../server/services/alerts/rules'
import { type GroupContext, groupLabel, partIdsOf, releaseNoPrefix, resolveGroup, splitAffectedSteps } from '../../server/services/releases/constants'

const ctx: GroupContext = {
  users: [
    { id: 'u-out', deptName: '生产部' },
    { id: 'u-head', deptName: '生产部' },
    { id: 'u-worker', deptName: '生产部' },
    { id: 'u-tech', deptName: '技术部' },
    { id: 'u-pdh', deptName: '项目部' },
    { id: 'u-nodept', deptName: null },
  ],
  roles: [
    { role: 'OUTSOURCE_COORDINATOR', userId: 'u-out', department: null },
    { role: 'OUTSOURCE_COORDINATOR', userId: 'u-gone', department: null }, // 已离职：不在 users 里
    { role: 'DEPT_HEAD', userId: 'u-head', department: '生产部' },
    { role: 'DEPT_HEAD', userId: 'u-tech', department: '技术部' },
    { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh', department: null },
  ],
}

describe('resolveGroup：部门 + 角色展开成人', () => {
  it('只填部门 = 该部门全部在职人员', () => {
    expect(resolveGroup({ department: '生产部' }, ctx).sort()).toEqual(['u-head', 'u-out', 'u-worker'])
  })
  it('部门负责人按 notify_role 的部门名称对应；不填部门 = 全部部门负责人', () => {
    expect(resolveGroup({ department: '生产部', role: 'DEPT_HEAD' }, ctx)).toEqual(['u-head'])
    expect(resolveGroup({ role: 'DEPT_HEAD' }, ctx).sort()).toEqual(['u-head', 'u-tech'])
  })
  it('其他角色按本人所在部门过滤，不在职的跳过', () => {
    expect(resolveGroup({ role: 'OUTSOURCE_COORDINATOR' }, ctx)).toEqual(['u-out'])
    expect(resolveGroup({ department: '技术部', role: 'OUTSOURCE_COORDINATOR' }, ctx)).toEqual([])
    expect(resolveGroup({ department: '项目部', role: 'PROJECT_DEPT_HEAD' }, ctx)).toEqual(['u-pdh'])
  })
  it('部门和角色都不填时没有人；部门名前后空格忽略', () => {
    expect(resolveGroup({}, ctx)).toEqual([])
    expect(resolveGroup({ department: ' 技术部 ' }, ctx)).toEqual(['u-tech'])
  })
  it('文案', () => {
    expect(groupLabel({ department: '生产部' })).toBe('生产部 · 全部人员')
    expect(groupLabel({ role: 'OUTSOURCE_COORDINATOR' })).toBe('外协专员')
  })
})

describe('splitAffectedSteps：设计变更影响', () => {
  it('加工中、在外加工 → 确认变更影响；待开工 → 等变更；已完成、有异常不动', () => {
    const steps = (['PENDING', 'OUT', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'PENDING'] as const).map((status, i) => ({ id: `s${i}`, status }))
    const r = splitAffectedSteps(steps)
    expect(r.started.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(r.hold.map((s) => s.id)).toEqual(['s0', 's5'])
  })
})

describe('编号与杂项', () => {
  it('FF-YYMMDD-，按工厂时区', () => {
    // UTC 10-18 17:00 = 北京 10-19 01:00
    expect(releaseNoPrefix(new Date('2026-10-18T17:00:00Z'))).toBe('FF-261019-')
  })
  it('partIdsOf 只取字符串', () => {
    expect(partIdsOf(['a', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(partIdsOf(null)).toEqual([])
  })
})

describe('W5 默认阈值：4 小时提醒、1 天黄、2 天红', () => {
  it('边界', () => {
    expect(levelByElapsed(3 * HOUR_MS, T.W5)).toBeNull()
    expect(levelByElapsed(4 * HOUR_MS, T.W5)).toBe('REMIND')
    expect(levelByElapsed(DAY_MS, T.W5)).toBe('YELLOW')
    expect(levelByElapsed(2 * DAY_MS, T.W5)).toBe('RED')
  })
})
