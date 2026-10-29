/** 生产管理重设计第二批：班组长——谁负责、班组长权限、第一道待办的统一规则、生产调度主按钮（纯函数） */
import { describe, expect, it } from 'vitest'
import { type RoleContext, canOperate, leaderTeamOfStep, menuSections, permissionFlags } from '../../server/services/auth/permissions'
import { pickResponsible, teamOfStep } from '../../server/services/flow/responsible'
import { firstStepTodoReady, prereqState } from '../../server/services/flow/readiness'
import { leaderAction, primaryAction } from '../../shared/production'

const ctx = (over: Partial<RoleContext> = {}): RoleContext => ({ userId: 'u', isAdmin: false, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set(), ...over })

describe('谁负责 pickResponsible', () => {
  const leaders = new Map([['T1', 'lead']])
  const all = () => true
  const step = (over: Partial<Parameters<typeof pickResponsible>[0]> = {}) => ({ ownerId: null, mode: 'SELF' as const, supplierId: 'T1', workOrderNumber: 'WO', ...over })

  it('负责人优先；没有时自制派到的班组的班组长', () => {
    expect(pickResponsible(step({ ownerId: 'owner' }), leaders, all)).toBe('owner')
    expect(pickResponsible(step(), leaders, all)).toBe('lead')
  })
  it('外协工序不找班组长（supplierId 是外协单位）；班组没设班组长、没派班组时为 null（由调用方兜底）', () => {
    expect(pickResponsible(step({ mode: 'IN_PLANT_OUTSOURCE' }), leaders, all)).toBeNull()
    expect(pickResponsible(step({ mode: 'EXTERNAL_OUTSOURCE' }), leaders, all)).toBeNull()
    expect(pickResponsible(step({ supplierId: 'T2' }), leaders, all)).toBeNull()
    expect(pickResponsible(step({ supplierId: null }), leaders, all)).toBeNull()
  })
  it('班组长看不到这个工单时不发给他', () => {
    expect(pickResponsible(step(), leaders, (uid, wo) => !(uid === 'lead' && wo === 'WO'))).toBeNull()
    expect(pickResponsible(step({ workOrderNumber: 'WO2' }), leaders, (uid, wo) => !(uid === 'lead' && wo === 'WO'))).toBe('lead')
  })
  it('班组只看自制工序', () => {
    expect(teamOfStep({ mode: 'SELF', supplierId: 'T1' })).toBe('T1')
    expect(teamOfStep({ mode: 'IN_PLANT_OUTSOURCE', supplierId: 'T1' })).toBeNull()
    expect(leaderTeamOfStep({ mode: 'SELF', supplierId: 'T1' })).toBe('T1')
    expect(leaderTeamOfStep({ mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S' })).toBeNull()
  })
})

describe('班组长权限', () => {
  const leader = ctx({ leadOf: ['T1'] })
  it('本班组自制工序可以开工 / 完工 / 报工；别的班组、外协（teamId 不传）不行', () => {
    expect(canOperate(leader, 'stepAction', { teamId: 'T1' })).toBe(true)
    expect(canOperate(leader, 'stepAction', { teamId: 'T2' })).toBe(false)
    expect(canOperate(leader, 'stepAction', { teamId: leaderTeamOfStep({ mode: 'IN_PLANT_OUTSOURCE', supplierId: 'T1' }) })).toBe(false)
    expect(canOperate(leader, 'stepAction', {})).toBe(false)
    expect(canOperate(ctx(), 'stepAction', { teamId: 'T1' })).toBe(false)
  })
  it('没有别的角色的班组长其余只读：改工序、设班组长都不行；菜单多一个生产', () => {
    expect(canOperate(leader, 'route', { workOrderNumber: 'WO' })).toBe(false)
    expect(canOperate(leader, 'teamLeader')).toBe(false)
    expect(permissionFlags(leader)).toMatchObject({ stepAction: false, route: false, teamLeader: false })
    expect(menuSections(leader)).toEqual(['production'])
    expect(menuSections(ctx())).toEqual([])
  })
  it('设班组长：生产部、管理员', () => {
    expect(canOperate(ctx({ businessDept: 'PRODUCTION' }), 'teamLeader')).toBe(true)
    expect(canOperate(ctx({ isAdmin: true }), 'teamLeader')).toBe(true)
    expect(canOperate(ctx({ businessDept: 'PROCESS' }), 'teamLeader')).toBe(false)
    expect(canOperate(ctx({ roles: ['OUTSOURCE_COORDINATOR'] }), 'teamLeader')).toBe(false)
  })
})

describe('第一道待办与生产调度同一条规则 firstStepTodoReady', () => {
  const tracked = (purchases: ('OPEN' | 'ARRIVED')[], drawings: ('PENDING' | 'DONE')[] = []) => prereqState({ purchases, drawings: drawings.map((status) => ({ status, materialStatus: 'ISSUED' })) })
  it('挂了物料 / 设计且都齐了、待开工、没在等变更才发', () => {
    expect(firstStepTodoReady({ status: 'PENDING', held: false }, tracked(['ARRIVED'], ['DONE']))).toBe(true)
    expect(firstStepTodoReady({ status: 'PENDING', held: false }, tracked(['OPEN']))).toBe(false) // 缺料：生产调度"卡住"
    expect(firstStepTodoReady({ status: 'PENDING', held: false }, tracked([], ['PENDING']))).toBe(false) // 缺图
    expect(firstStepTodoReady({ status: 'PENDING', held: true }, tracked(['ARRIVED']))).toBe(false) // 等变更
    expect(firstStepTodoReady({ status: 'OUT', held: false }, tracked(['ARRIVED']))).toBe(false) // 已发出
    expect(firstStepTodoReady(null, tracked(['ARRIVED']))).toBe(false) // 还没排工序
  })
  it('什么都没挂的工件不发（原规则不变）', () => {
    expect(firstStepTodoReady({ status: 'PENDING', held: false }, tracked([]))).toBe(false)
  })
})

describe('生产调度主按钮：班组长', () => {
  const ready = { column: 'ready' as const, status: 'PENDING' as const, mode: 'SELF' as const, ownerId: null }
  it('没负责人但有班组长：直接"开工"，不用先指定负责人', () => {
    expect(primaryAction(ready)).toBe('assign')
    expect(primaryAction({ ...ready, leaderId: 'lead' })).toBe('start')
  })
  it('班组长只能点开工、完工', () => {
    expect(leaderAction('start')).toBe(true)
    expect(leaderAction('finish')).toBe(true)
    expect(leaderAction('send')).toBe(false)
    expect(leaderAction('return')).toBe(false)
    expect(leaderAction('assign')).toBe(false)
  })
})
