import { describe, expect, it } from 'vitest'
import { canDo, canDoAny, type Me, type Operation } from '../../app/composables/useMe'
import { canOperate, permissionFlags, type RoleContext, leaderTeamOfStep } from '../../server/services/auth/permissions'
import { canLeadStepAction, isObjectOwner, isProjectManagerOf } from '../../shared/permissions'

const context = (over: Partial<RoleContext> = {}): RoleContext => ({ userId: 'u', isAdmin: false, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set(), ...over })
const meOf = (ctx: RoleContext): Me => ({
  id: ctx.userId, name: '用户', department: null, roleName: null, devTools: false, isAdmin: ctx.isAdmin,
  roles: ctx.roles, deptHeadOf: ctx.deptHeadOf, businessDept: ctx.businessDept, businessDeptName: null,
  pmOf: [...ctx.pmOf], limited: false, menu: [], leadTeams: (ctx.leadOf ?? []).map(id => ({ id, name: id })), can: permissionFlags(ctx),
})

const cases: { name: string; ctx: RoleContext; op: Operation; target: NonNullable<Parameters<typeof canDo>[2]>; allowed: boolean }[] = [
  { name: '普通人', ctx: context(), op: 'purchase', target: { workOrderNumber: 'WO' }, allowed: false },
  ...(['purchase', 'payment', 'route', 'plan'] as const).flatMap(op => [
    { name: `本人工单项目经理 ${op}`, ctx: context({ pmOf: new Set(['WO']) }), op, target: { workOrderNumber: 'WO' }, allowed: true },
    { name: `别人工单项目经理 ${op}`, ctx: context({ pmOf: new Set(['OTHER']) }), op, target: { workOrderNumber: 'WO' }, allowed: false },
  ]),
  { name: '项目经理不因负责工单就能改设计', ctx: context({ pmOf: new Set(['WO']) }), op: 'drawing', target: { workOrderNumber: 'WO' }, allowed: false },
  { name: '部门负责人基准权限', ctx: context({ deptHeadOf: ['采购部'] }), op: 'purchase', target: {}, allowed: true },
  { name: '项目部负责人基准权限', ctx: context({ roles: ['PROJECT_DEPT_HEAD'] }), op: 'plan', target: {}, allowed: true },
  { name: '管理员', ctx: context({ isAdmin: true }), op: 'drawing', target: {}, allowed: true },
  { name: '本人负责人', ctx: context(), op: 'stepAction', target: { ownerId: 'u' }, allowed: true },
  { name: '他人负责人', ctx: context(), op: 'stepAction', target: { ownerId: 'other' }, allowed: false },
  { name: '空负责人', ctx: context({ userId: '' }), op: 'stepAction', target: { ownerId: '' }, allowed: false },
  { name: '本班组自制开工', ctx: context({ leadOf: ['T'] }), op: 'stepAction', target: { mode: 'SELF', supplierId: 'T', leaderAction: true }, allowed: true },
  { name: '其他班组', ctx: context({ leadOf: ['OTHER'] }), op: 'stepAction', target: { mode: 'SELF', supplierId: 'T', leaderAction: true }, allowed: false },
  { name: '厂内外协不按班组放行', ctx: context({ leadOf: ['T'] }), op: 'stepAction', target: { mode: 'IN_PLANT_OUTSOURCE', supplierId: 'T', leaderAction: true }, allowed: false },
  { name: '厂外外协不按班组放行', ctx: context({ leadOf: ['T'] }), op: 'stepAction', target: { mode: 'EXTERNAL_OUTSOURCE', supplierId: 'T', leaderAction: true }, allowed: false },
  { name: '发出返厂不是班组长操作', ctx: context({ leadOf: ['T'] }), op: 'stepAction', target: { mode: 'SELF', supplierId: 'T', leaderAction: false }, allowed: false },
]

describe('权限搬移前差异表：前端对象补充与服务端规则', () => {
  it.each(cases)('$name', ({ ctx, op, target, allowed }) => {
    expect(canDo(meOf(ctx), op, target)).toBe(allowed)
    expect(canOperate(ctx, op, {
      workOrderNumber: target?.workOrderNumber, ownerId: target?.ownerId,
      teamId: target?.leaderAction ? leaderTeamOfStep({ mode: target.mode ?? '', supplierId: target.supplierId ?? null }) : null,
    })).toBe(allowed)
    expect(isProjectManagerOf(ctx.pmOf, target?.workOrderNumber)).toBe(isProjectManagerOf(meOf(ctx).pmOf, target?.workOrderNumber))
    if (op === 'stepAction') expect(isObjectOwner(ctx.userId, target?.ownerId) || canLeadStepAction(ctx.leadOf, target ?? {})).toBe(allowed)
  })

  it('未登录按钮不可用；列表级按钮只表示某工单可能可操作', () => {
    expect(canDo(null, 'purchase')).toBe(false)
    expect(canDoAny(undefined, 'plan')).toBe(false)
    const ctx = context({ pmOf: new Set(['OTHER']) })
    expect(canDoAny(meOf(ctx), 'purchase')).toBe(true)
    expect(canDo(meOf(ctx), 'purchase', { workOrderNumber: 'WO' })).toBe(false)
    expect(canOperate(ctx, 'purchase', { workOrderNumber: 'WO' })).toBe(false)
  })

  it('前端发放按钮是通用入口；服务端按文件类型最终拒绝工艺部发图纸', () => {
    const ctx = context({ businessDept: 'PROCESS' })
    expect(canDo(meOf(ctx), 'release')).toBe(true)
    expect(canOperate(ctx, 'release', { releaseType: 'DRAWING' })).toBe(false)
    expect(canOperate(ctx, 'release', { releaseType: 'PROCESS' })).toBe(true)
    expect(meOf(ctx).can.releaseProcessOnly).toBe(true)
  })

  it('服务端可判断报检的多个关联工单；前端 canDo 只接收单个工单', () => {
    const ctx = context({ pmOf: new Set(['OTHER']) })
    expect(canDo(meOf(ctx), 'route', { workOrderNumber: 'WO' })).toBe(false)
    expect(canOperate(ctx, 'route', { workOrderNumbers: ['WO', null, undefined, 'OTHER'] })).toBe(true)
  })
})
