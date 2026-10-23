/** 权限方案 R13：部门换算、操作权限、付款金额可见、菜单分组、领导总览的纯函数 */
import { describe, expect, it } from 'vitest'
import { type DeptIndex, deptIdsResolvingTo, representativeDeptId, resolveBusinessDept, resolveDeptName } from '../../server/services/auth/departments'
import { type RoleContext, canOperate, canSeeAmount, canSeeMobileSend, canSeeOverview, inDept, isDeptHead, menuSections, permissionFlags } from '../../server/services/auth/permissions'
import { deptRows } from '../../server/services/alerts/settings'
import { resolveGroup } from '../../server/services/releases/constants'
import { redReason, weekStart } from '../../server/services/issues/overview'

const index = (depts: Record<string, [string, string | null, boolean?]>, mapping: Record<string, RoleContext['businessDept']> = {}): DeptIndex => ({
  depts: new Map(Object.entries(depts).map(([id, [name, parentId, isDeleted]]) => [id, { name, parentId, isDeleted }])),
  mapping: new Map(Object.entries(mapping).filter((e): e is [string, NonNullable<RoleContext['businessDept']>] => !!e[1])),
})

describe('部门换算 resolveDeptName', () => {
  const idx = index(
    {
      D1: ['生产中心', '0'],
      D2: ['组焊班', 'D1'],
      D3: ['组焊一组', 'D2'],
      D4: ['生产部', '0'], // 没有对照，名称正好是业务部门名
      D5: ['行政部', '0'],
      D6: ['技术部', 'D1'], // 名称是技术部，但上级对到生产部：对照优先
      C1: ['环 A', 'C2'],
      C2: ['环 B', 'C1'],
    },
    { D1: 'PRODUCTION', D2: null },
  )

  it('本部门有对照 → 业务部门名', () => {
    expect(resolveDeptName('D1', idx)).toBe('生产部')
    expect(resolveBusinessDept('D1', idx)).toBe('PRODUCTION')
  })

  it('本部门没有对照 → 沿上级找最近有对照的（多级）', () => {
    expect(resolveDeptName('D2', idx)).toBe('生产部')
    expect(resolveDeptName('D3', idx)).toBe('生产部')
    expect(resolveDeptName('D6', idx)).toBe('生产部')
  })

  it('都没有对照 → 退回 QMS 部门名称本身（名称正好是业务部门的照常生效）', () => {
    expect(resolveDeptName('D4', idx)).toBe('生产部')
    expect(resolveBusinessDept('D4', idx)).toBe('PRODUCTION')
    expect(resolveDeptName('D5', idx)).toBe('行政部')
    expect(resolveBusinessDept('D5', idx)).toBeNull()
  })

  it('成环不死循环；未同步的部门、空 ID 为 null', () => {
    expect(resolveDeptName('C1', idx)).toBe('环 A')
    expect(resolveDeptName('NOPE', idx)).toBeNull()
    expect(resolveDeptName(null, idx)).toBeNull()
  })

  it('子部门对照到别的业务部门时以最近的为准', () => {
    const i2 = index({ P: ['总部', '0'], Q: ['质检科', 'P'], R: ['质检一组', 'Q'] }, { P: 'PRODUCTION', Q: 'QUALITY' })
    expect(resolveDeptName('R', i2)).toBe('质量部')
    expect(resolveDeptName('P', i2)).toBe('生产部')
  })

  it('层级过深时停止向上找，退回本部门名称', () => {
    const depts: Record<string, [string, string | null]> = { L0: ['顶层', '0'] }
    for (let i = 1; i <= 15; i++) depts[`L${i}`] = [`第 ${i} 层`, `L${i - 1}`]
    const deep = index(depts, { L0: 'TECH' })
    expect(resolveDeptName('L5', deep)).toBe('技术部')
    expect(resolveDeptName('L15', deep)).toBe('第 15 层')
  })

  it('deptIdsResolvingTo：换算后同名的全部部门（本部门筛选）', () => {
    expect(deptIdsResolvingTo('生产部', idx).sort()).toEqual(['D1', 'D2', 'D3', 'D4', 'D6'])
  })

  it('representativeDeptId：先按名称，再按直接对照（上级最少），跳过已删除', () => {
    expect(representativeDeptId('生产部', idx)).toBe('D4')
    const i2 = index({ A: ['制造中心', '0'], B: ['机加车间', 'A'], X: ['生产部', '0', true] }, { A: 'PRODUCTION', B: 'PRODUCTION' })
    expect(representativeDeptId('生产部', i2)).toBe('A')
    expect(representativeDeptId('财务部', i2)).toBeNull()
    expect(representativeDeptId('公司领导', i2)).toBeNull()
  })
})

const ctx = (over: Partial<RoleContext> = {}): RoleContext => ({
  userId: 'me',
  isAdmin: false,
  roles: [],
  deptHeadOf: [],
  businessDept: null,
  pmOf: new Set(),
  ...over,
})

describe('操作权限 canOperate', () => {
  const tech = ctx({ businessDept: 'TECH' })
  const techHead = ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['技术部'] })
  const buyer = ctx({ businessDept: 'PURCHASE' })
  const prod = ctx({ businessDept: 'PRODUCTION' })
  const prodHead = ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['生产部'] })
  const outsource = ctx({ roles: ['OUTSOURCE_COORDINATOR'] })
  const pm = ctx({ businessDept: 'PROJECT', pmOf: new Set(['WO-1']) })
  const quality = ctx({ businessDept: 'QUALITY' })
  const other = ctx()
  const admin = ctx({ isAdmin: true })
  const leader = ctx({ roles: ['LEADER'] })

  it('部门员工包括该部门负责人', () => {
    expect(inDept(techHead, 'TECH')).toBe(true)
    expect(inDept(techHead, 'PRODUCTION')).toBe(false)
    expect(inDept(prod, 'PRODUCTION')).toBe(true)
  })

  it('设计任务、发放单：技术部、管理员', () => {
    for (const op of ['drawing', 'release'] as const) {
      expect(canOperate(tech, op)).toBe(true)
      expect(canOperate(techHead, op)).toBe(true)
      expect(canOperate(admin, op)).toBe(true)
      expect(canOperate(pm, op, { workOrderNumber: 'WO-1' })).toBe(false)
      expect(canOperate(prod, op)).toBe(false)
      expect(canOperate(leader, op)).toBe(false)
    }
  })

  it('采购行、付款申请：采购部、该工单项目经理、管理员', () => {
    for (const op of ['purchase', 'payment'] as const) {
      expect(canOperate(buyer, op, { workOrderNumber: 'WO-9' })).toBe(true)
      expect(canOperate(pm, op, { workOrderNumber: 'WO-1' })).toBe(true)
      expect(canOperate(pm, op, { workOrderNumber: 'WO-2' })).toBe(false)
      expect(canOperate(admin, op)).toBe(true)
      expect(canOperate(prod, op, { workOrderNumber: 'WO-1' })).toBe(false)
      expect(canOperate(ctx({ roles: ['FINANCE'] }), op, { workOrderNumber: 'WO-1' })).toBe(false)
    }
  })

  it('工件工序编辑：生产部、外协专员、该工单项目经理、管理员；质量部只读', () => {
    expect(canOperate(prod, 'route', { workOrderNumber: 'WO-9' })).toBe(true)
    expect(canOperate(prodHead, 'route')).toBe(true)
    expect(canOperate(outsource, 'route')).toBe(true)
    expect(canOperate(pm, 'route', { workOrderNumber: 'WO-1' })).toBe(true)
    expect(canOperate(pm, 'route', { workOrderNumbers: ['WO-3', 'WO-1'] })).toBe(true)
    expect(canOperate(pm, 'route', { workOrderNumber: 'WO-2' })).toBe(false)
    expect(canOperate(quality, 'route')).toBe(false)
    expect(canOperate(tech, 'route')).toBe(false)
  })

  it('开工/完工/发出/返厂：生产部、外协专员、该工序责任人、管理员（项目经理不行）', () => {
    expect(canOperate(prod, 'stepAction')).toBe(true)
    expect(canOperate(outsource, 'stepAction')).toBe(true)
    expect(canOperate(admin, 'stepAction')).toBe(true)
    expect(canOperate(tech, 'stepAction', { ownerId: 'me' })).toBe(true)
    expect(canOperate(tech, 'stepAction', { ownerId: 'someone' })).toBe(false)
    expect(canOperate(tech, 'stepAction', { ownerId: null })).toBe(false)
    expect(canOperate(pm, 'stepAction', { workOrderNumber: 'WO-1' })).toBe(false)
  })

  it('其他部门什么都改不了', () => {
    for (const op of ['drawing', 'release', 'purchase', 'payment', 'route', 'stepAction'] as const) expect(canOperate(other, op, { workOrderNumber: 'WO-1' })).toBe(false)
  })
})

describe('总计划权限（R14）', () => {
  const pm = ctx({ pmOf: new Set(['WO-1']) })
  const project = ctx({ businessDept: 'PROJECT' })
  const projectHead = ctx({ roles: ['PROJECT_DEPT_HEAD'] })
  const projectDeptHead = ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['项目部'] })
  const techHead = ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['技术部'] })
  const tech = ctx({ businessDept: 'TECH' })
  const admin = ctx({ isAdmin: true })
  const leader = ctx({ roles: ['LEADER'] })

  it('编辑总计划 plan：该工单项目经理、项目部、项目部负责人、管理员', () => {
    expect(canOperate(pm, 'plan', { workOrderNumber: 'WO-1' })).toBe(true)
    expect(canOperate(pm, 'plan', { workOrderNumber: 'WO-2' })).toBe(false)
    expect(canOperate(project, 'plan', { workOrderNumber: 'WO-2' })).toBe(true)
    expect(canOperate(projectHead, 'plan', { workOrderNumber: 'WO-2' })).toBe(true)
    expect(canOperate(admin, 'plan', { workOrderNumber: 'WO-2' })).toBe(true)
    for (const c of [tech, techHead, leader]) expect(canOperate(c, 'plan', { workOrderNumber: 'WO-1' })).toBe(false)
  })

  it('维护模板 planTemplate：项目部负责人（角色或项目部的部门负责人）、管理员；项目经理、项目部普通员工不行', () => {
    expect(canOperate(projectHead, 'planTemplate')).toBe(true)
    expect(canOperate(projectDeptHead, 'planTemplate')).toBe(true)
    expect(canOperate(admin, 'planTemplate')).toBe(true)
    for (const c of [pm, project, techHead, leader]) expect(canOperate(c, 'planTemplate')).toBe(false)
  })

  it('确认节点 planConfirm：该节点责任部门的负责人（项目部节点另含项目部负责人角色）、管理员', () => {
    expect(canOperate(techHead, 'planConfirm', { dept: 'TECH' })).toBe(true)
    expect(canOperate(techHead, 'planConfirm', { dept: 'PURCHASE' })).toBe(false)
    expect(canOperate(tech, 'planConfirm', { dept: 'TECH' })).toBe(false)
    expect(canOperate(projectHead, 'planConfirm', { dept: 'PROJECT' })).toBe(true)
    expect(canOperate(projectHead, 'planConfirm', { dept: 'TECH' })).toBe(false)
    expect(canOperate(pm, 'planConfirm', { workOrderNumber: 'WO-1', dept: 'TECH' })).toBe(false)
    expect(canOperate(admin, 'planConfirm', { dept: 'TECH' })).toBe(true)
    expect(canOperate(techHead, 'planConfirm', {})).toBe(false)
    expect(isDeptHead(projectDeptHead, 'PROJECT')).toBe(true)
    expect(isDeptHead(techHead, 'PROJECT')).toBe(false)
  })

  it('手动完成节点 planNodeDone：责任部门的人（含负责人）、该工单项目经理、管理员', () => {
    expect(canOperate(tech, 'planNodeDone', { workOrderNumber: 'WO-1', dept: 'TECH' })).toBe(true)
    expect(canOperate(techHead, 'planNodeDone', { workOrderNumber: 'WO-1', dept: 'TECH' })).toBe(true)
    expect(canOperate(tech, 'planNodeDone', { workOrderNumber: 'WO-1', dept: 'PURCHASE' })).toBe(false)
    expect(canOperate(pm, 'planNodeDone', { workOrderNumber: 'WO-1', dept: 'PURCHASE' })).toBe(true)
    expect(canOperate(pm, 'planNodeDone', { workOrderNumber: 'WO-2', dept: 'PURCHASE' })).toBe(false)
    expect(canOperate(admin, 'planNodeDone', { workOrderNumber: 'WO-2', dept: 'PURCHASE' })).toBe(true)
  })

  it('分解节点 planTask：节点责任部门的人（含负责人）、该工单项目经理、项目部、项目部负责人、管理员；别的部门、领导不行', () => {
    expect(canOperate(tech, 'planTask', { workOrderNumber: 'WO-1', dept: 'TECH' })).toBe(true)
    expect(canOperate(techHead, 'planTask', { workOrderNumber: 'WO-1', dept: 'TECH' })).toBe(true)
    expect(canOperate(tech, 'planTask', { workOrderNumber: 'WO-1', dept: 'PRODUCTION' })).toBe(false)
    expect(canOperate(pm, 'planTask', { workOrderNumber: 'WO-1', dept: 'PRODUCTION' })).toBe(true)
    expect(canOperate(pm, 'planTask', { workOrderNumber: 'WO-2', dept: 'PRODUCTION' })).toBe(false)
    expect(canOperate(project, 'planTask', { workOrderNumber: 'WO-2', dept: 'PRODUCTION' })).toBe(true)
    expect(canOperate(projectHead, 'planTask', { workOrderNumber: 'WO-2', dept: 'QUALITY' })).toBe(true)
    expect(canOperate(projectDeptHead, 'planTask', { workOrderNumber: 'WO-2', dept: 'QUALITY' })).toBe(true)
    expect(canOperate(leader, 'planTask', { workOrderNumber: 'WO-2', dept: 'QUALITY' })).toBe(false)
    expect(canOperate(admin, 'planTask', { workOrderNumber: 'WO-2', dept: 'QUALITY' })).toBe(true)
  })

  it('permissionFlags 带 plan / planTemplate（项目经理靠按工单判断，不在标志里）', () => {
    expect(permissionFlags(project)).toMatchObject({ plan: true, planTemplate: false })
    expect(permissionFlags(projectHead)).toMatchObject({ plan: true, planTemplate: true })
    expect(permissionFlags(pm)).toMatchObject({ plan: false, planTemplate: false })
  })
})

describe('付款金额可见 canSeeAmount', () => {
  it('财务、采购部、领导、项目部负责人、管理员能看', () => {
    expect(canSeeAmount(ctx({ roles: ['FINANCE'] }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ businessDept: 'FINANCE' }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ businessDept: 'PURCHASE' }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['采购部'] }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ roles: ['LEADER'] }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ roles: ['PROJECT_DEPT_HEAD'] }), 'WO-1')).toBe(true)
    expect(canSeeAmount(ctx({ isAdmin: true }), 'WO-1')).toBe(true)
  })

  it('项目经理只看自己的工单', () => {
    const pm = ctx({ pmOf: new Set(['WO-1']) })
    expect(canSeeAmount(pm, 'WO-1')).toBe(true)
    expect(canSeeAmount(pm, 'WO-2')).toBe(false)
  })

  it('技术部、生产部、外协专员、质量部、其他部门不能看', () => {
    for (const c of [ctx({ businessDept: 'TECH' }), ctx({ businessDept: 'PRODUCTION' }), ctx({ roles: ['OUTSOURCE_COORDINATOR'] }), ctx({ businessDept: 'QUALITY' }), ctx(), ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['生产部'] })]) {
      expect(canSeeAmount(c, 'WO-1')).toBe(false)
    }
  })
})

describe('电脑端菜单 menuSections', () => {
  const ALL = ['tech', 'purchase', 'production']
  it('领导、项目部负责人、管理员：全部 + 领导总览', () => {
    for (const c of [ctx({ roles: ['LEADER'] }), ctx({ roles: ['PROJECT_DEPT_HEAD'] }), ctx({ isAdmin: true })]) {
      expect(menuSections(c)).toEqual(['overview', 'deptPlan', ...ALL])
      expect(canSeeOverview(c)).toBe(true)
    }
  })

  it('项目经理（至少负责一个工单）：全部，但没有领导总览', () => {
    const pm = ctx({ pmOf: new Set(['WO-1']) })
    expect(menuSections(pm)).toEqual(ALL)
    expect(canSeeOverview(pm)).toBe(false)
  })

  it('各部门（有业务部门的人都有"部门计划"）', () => {
    expect(menuSections(ctx({ businessDept: 'TECH' }))).toEqual(['deptPlan', 'tech'])
    expect(menuSections(ctx({ businessDept: 'PURCHASE' }))).toEqual(['deptPlan', 'purchase', 'kitting'])
    expect(menuSections(ctx({ businessDept: 'PRODUCTION' }))).toEqual(['deptPlan', 'production', 'releases'])
    expect(menuSections(ctx({ roles: ['OUTSOURCE_COORDINATOR'] }))).toEqual(['production', 'releases'])
    expect(menuSections(ctx({ businessDept: 'QUALITY' }))).toEqual(['deptPlan', 'production'])
    expect(menuSections(ctx({ roles: ['FINANCE'] }))).toEqual(['payments'])
    expect(menuSections(ctx({ businessDept: 'PROJECT' }))).toEqual(['deptPlan'])
    expect(menuSections(ctx())).toEqual([])
  })

  it('多角色取并集；部门负责人按负责的部门', () => {
    expect(menuSections(ctx({ businessDept: 'TECH', roles: ['FINANCE'] }))).toEqual(['deptPlan', 'tech', 'payments'])
    expect(menuSections(ctx({ roles: ['DEPT_HEAD'], deptHeadOf: ['采购部', '质量部'] }))).toEqual(['deptPlan', 'purchase', 'production', 'kitting'])
  })

  it('手机端"发出"页签：生产部、外协专员、管理员', () => {
    expect(canSeeMobileSend(ctx({ businessDept: 'PRODUCTION' }))).toBe(true)
    expect(canSeeMobileSend(ctx({ roles: ['OUTSOURCE_COORDINATOR'] }))).toBe(true)
    expect(canSeeMobileSend(ctx({ isAdmin: true }))).toBe(true)
    expect(canSeeMobileSend(ctx({ businessDept: 'QUALITY' }))).toBe(false)
    expect(canSeeMobileSend(ctx({ pmOf: new Set(['WO-1']) }))).toBe(false)
  })

  it('permissionFlags 不含按对象判断的部分', () => {
    expect(permissionFlags(ctx({ pmOf: new Set(['WO-1']) }))).toMatchObject({ purchase: false, route: false, seeAmount: false, overview: false })
    expect(permissionFlags(ctx({ businessDept: 'PURCHASE' }))).toMatchObject({ purchase: true, payment: true, seeAmount: true, route: false, stepAction: false })
  })
})

describe('设置页部门对照行 deptRows', () => {
  it('按层级排、带上级名称、标出实际生效的业务部门', () => {
    const rows = deptRows(
      [
        { id: 'B', name: '组焊班', parentId: 'A' },
        { id: 'A', name: '制造中心', parentId: '0' },
        { id: 'C', name: '技术部', parentId: '0' },
        { id: 'D', name: '行政部', parentId: '0' },
      ],
      new Map([['A', 'PRODUCTION']]),
    )
    expect(rows.map((r) => [r.name, r.level, r.parentName, r.businessDept, r.effective])).toEqual([
      ['制造中心', 0, null, 'PRODUCTION', '生产部'],
      ['组焊班', 1, '制造中心', null, '生产部'],
      ['技术部', 0, null, null, '技术部'],
      ['行政部', 0, null, null, null],
    ])
  })
})

describe('发放按部门选人 resolveGroup', () => {
  it('选业务部门名时，经部门对照算进来的班组成员也算；按 QMS 原名称选仍然可以', () => {
    const g = {
      users: [
        { id: 'u1', deptName: '组焊班', businessDeptName: '生产部' },
        { id: 'u2', deptName: '生产部', businessDeptName: '生产部' },
        { id: 'u3', deptName: '技术部', businessDeptName: '技术部' },
      ],
      roles: [],
    }
    expect(resolveGroup({ department: '生产部' }, g).sort()).toEqual(['u1', 'u2'])
    expect(resolveGroup({ department: '组焊班' }, g)).toEqual(['u1'])
  })
})

describe('领导总览', () => {
  const bj = (s: string) => new Date(`${s}+08:00`)
  it('本周 = 北京时间本周一 00:00 起', () => {
    expect(weekStart(bj('2026-10-21T15:00:00')).toISOString()).toBe(bj('2026-10-19T00:00:00').toISOString()) // 周三
    expect(weekStart(bj('2026-10-19T00:00:00')).toISOString()).toBe(bj('2026-10-19T00:00:00').toISOString()) // 周一零点
    expect(weekStart(bj('2026-10-25T23:59:59')).toISOString()).toBe(bj('2026-10-19T00:00:00').toISOString()) // 周日
    expect(weekStart(bj('2026-10-26T00:30:00')).toISOString()).toBe(bj('2026-10-26T00:00:00').toISOString()) // UTC 还是周日
  })

  it('红色工单原因由看板数字拼成', () => {
    const zero = { redAlerts: 0, overdueIssues: 0, overdueSteps: 0, shortage: 0, drawingOverdue: 0, incompleteNodes: 0, unsignedReleases: 0 }
    expect(redReason({ ...zero, redAlerts: 2, shortage: 1 })).toBe('红色预警 2 项；缺料 1 项')
    expect(redReason(zero)).toBe('—')
  })
})
