/**
 * 角色与操作权限（权限方案 R13 第二、三节）。角色固定，规则写死在这里，不做可配置的权限矩阵。
 * 纯函数，不碰数据库，便于单测；角色上下文由 server/utils/auth.ts 的 getRoleContext 按请求算一次。
 *
 * "部门员工"包括该部门的负责人（DEPT_HEAD 且 department = 该业务部门名）。
 * 可见范围（resolveScope）不在这里，规则不变。
 */
import type { NotifyRoleKind } from '@prisma/client'
import { BUSINESS_DEPT_NAME, type BusinessDept } from './departments'

export interface RoleContext {
  userId: string
  isAdmin: boolean
  /** 通知角色（设置页"人员与角色"） */
  roles: NotifyRoleKind[]
  /** 担任负责人的部门（notify_role.department） */
  deptHeadOf: string[]
  /** 本人 QMS 部门换算出的业务部门（没对上的为 null，算"其他"） */
  businessDept: BusinessDept | null
  /** 担任项目经理的工单 */
  pmOf: Set<string>
}

const has = (ctx: RoleContext, role: NotifyRoleKind) => ctx.roles.includes(role)

/** 是该业务部门的人：本人业务部门是它，或是它的部门负责人 */
export function inDept(ctx: RoleContext, dept: BusinessDept): boolean {
  return ctx.businessDept === dept || ctx.deptHeadOf.includes(BUSINESS_DEPT_NAME[dept])
}

/** 领导、项目部负责人、管理员：看全部菜单、领导总览 */
export function isLeaderLike(ctx: RoleContext): boolean {
  return ctx.isAdmin || has(ctx, 'LEADER') || has(ctx, 'PROJECT_DEPT_HEAD')
}

const isPM = (ctx: RoleContext, wo: string | null | undefined) => !!wo && ctx.pmOf.has(wo)

// ───────────── 操作（第三节 ★ 行）─────────────

/**
 * drawing：建/改/删设计任务、录/撤客户确认 —— 技术部、管理员
 * release：建发放单 —— 技术部、管理员（作废仍限发放人或管理员，在发放服务里判断）
 * purchase：建/改/删采购行、Excel 导入、手工标到货/撤销 —— 采购部、该工单项目经理、管理员
 * payment：提付款申请 —— 采购部、该工单项目经理、管理员
 * route：建/改/删工件和工序、调工序顺序、导入 BOM、套模板/复制路线、处理/忽略待确认匹配 —— 生产部、外协专员、该工单项目经理、管理员
 * stepAction：开工/完工/发出/补登返厂 —— 生产部、外协专员、该工序责任人、管理员
 *
 * 总计划（R14，总计划设计第 8 节）：
 * plan：建/改/发布总计划、调整日期、增删节点 —— 该工单项目经理、项目部（含项目部负责人）、管理员
 * planTemplate：维护总计划模板 —— 项目部负责人、管理员
 * planConfirm：确认/退回节点 —— 该节点责任部门负责人、管理员（项目部的节点：项目部负责人也算）；手里有这条确认待办的人（转交来的）由服务层另外放行
 * planNodeDone：手动标记节点完成 / 撤销 —— 该节点责任部门的人、该工单项目经理、管理员
 * planTask：在节点下分解"其他任务"（建 / 改 / 删 / 标完成）—— 该节点责任部门的人、该工单项目经理、项目部（含项目部负责人）、管理员；
 *   任务负责人本人可以标完成 / 撤销（接口层另外放行）
 */
export type Operation = 'drawing' | 'release' | 'purchase' | 'payment' | 'route' | 'stepAction' | 'plan' | 'planTemplate' | 'planConfirm' | 'planNodeDone' | 'planTask'

export interface OperationTarget {
  /** 所属工单（判断"该工单项目经理"） */
  workOrderNumber?: string | null
  /** 也算项目经理的其他工单（如报检关联了多个工单） */
  workOrderNumbers?: (string | null | undefined)[]
  /** 工序责任人（stepAction） */
  ownerId?: string | null
  /** 总计划节点的责任部门（planConfirm、planNodeDone、planTask） */
  dept?: BusinessDept | null
}

export const OPERATION_DENIED: Record<Operation, string> = {
  drawing: '只有技术部或管理员可以编辑设计任务',
  release: '只有技术部或管理员可以新建发放单',
  purchase: '只有采购部、该工单项目经理或管理员可以修改采购行或登记到货',
  payment: '只有采购部、该工单项目经理或管理员可以提付款申请',
  route: '只有生产部、外协专员、该工单项目经理或管理员可以修改工件和工序',
  stepAction: '只有生产部、外协专员、该工序责任人或管理员可以登记开工、完工、发出、返厂',
  plan: '只有该工单项目经理、项目部或管理员可以编辑、发布总计划',
  planTemplate: '只有项目部负责人或管理员可以维护总计划模板',
  planConfirm: '只有该节点责任部门的负责人或管理员可以确认、退回总计划节点',
  planNodeDone: '只有该节点责任部门的人、该工单项目经理或管理员可以标记节点完成',
  planTask: '只有该节点责任部门的人、该工单项目经理、项目部或管理员可以分解这个节点',
}

export function canOperate(ctx: RoleContext, op: Operation, target: OperationTarget = {}): boolean {
  if (ctx.isAdmin) return true
  const pm = isPM(ctx, target.workOrderNumber) || (target.workOrderNumbers ?? []).some((wo) => isPM(ctx, wo))
  const outsource = has(ctx, 'OUTSOURCE_COORDINATOR')
  switch (op) {
    case 'drawing':
    case 'release':
      return inDept(ctx, 'TECH')
    case 'purchase':
    case 'payment':
      return inDept(ctx, 'PURCHASE') || pm
    case 'route':
      return inDept(ctx, 'PRODUCTION') || outsource || pm
    case 'stepAction':
      return inDept(ctx, 'PRODUCTION') || outsource || (!!target.ownerId && target.ownerId === ctx.userId)
    case 'plan':
      return pm || inDept(ctx, 'PROJECT') || has(ctx, 'PROJECT_DEPT_HEAD')
    case 'planTemplate':
      return isProjectHead(ctx)
    case 'planConfirm':
      return !!target.dept && isDeptHead(ctx, target.dept)
    case 'planNodeDone':
      return pm || (!!target.dept && inDept(ctx, target.dept))
    case 'planTask':
      return pm || inDept(ctx, 'PROJECT') || has(ctx, 'PROJECT_DEPT_HEAD') || (!!target.dept && inDept(ctx, target.dept))
  }
}

/** 项目部负责人：通知角色"项目部负责人"，或部门负责人且部门是项目部 */
const isProjectHead = (ctx: RoleContext) => has(ctx, 'PROJECT_DEPT_HEAD') || ctx.deptHeadOf.includes(BUSINESS_DEPT_NAME.PROJECT)

/** 某业务部门的负责人（项目部另含"项目部负责人"角色） */
export function isDeptHead(ctx: RoleContext, dept: BusinessDept): boolean {
  return ctx.deptHeadOf.includes(BUSINESS_DEPT_NAME[dept]) || (dept === 'PROJECT' && has(ctx, 'PROJECT_DEPT_HEAD'))
}

/** 财务：通知角色"财务"，或业务部门是财务部的人 */
const isFinance = (ctx: RoleContext) => has(ctx, 'FINANCE') || inDept(ctx, 'FINANCE')

/** 付款金额可见：财务、采购部、领导、项目部负责人、管理员、该工单项目经理 */
export function canSeeAmount(ctx: RoleContext, workOrderNumber: string | null | undefined): boolean {
  return isLeaderLike(ctx) || isFinance(ctx) || inDept(ctx, 'PURCHASE') || isPM(ctx, workOrderNumber)
}

/** 手机端"发出"页签：生产部、外协专员、管理员 */
export function canSeeMobileSend(ctx: RoleContext): boolean {
  return ctx.isAdmin || inDept(ctx, 'PRODUCTION') || has(ctx, 'OUTSOURCE_COORDINATOR')
}

/** 领导总览：领导、项目部负责人、管理员 */
export const canSeeOverview = isLeaderLike

// ───────────── 电脑端菜单（第二节）─────────────

/**
 * 菜单分区（"每日"组人人都有，不在这里）：
 *   tech = 设计任务 + 发放签收；purchase = 采购到货 + 付款申请；production = 齐套 + 工件与工序链 + 路线模板 + 待确认匹配；
 *   kitting = 齐套；releases = 发放签收；payments = 付款申请；overview = 领导总览。
 * 页面本身不拦，只是不在菜单里显示（从提醒链接点进去仍能只读查看）。
 */
export type MenuSection = 'overview' | 'tech' | 'purchase' | 'production' | 'kitting' | 'releases' | 'payments'

/** 多角色取并集；返回固定顺序，便于比较 */
export function menuSections(ctx: RoleContext): MenuSection[] {
  const out = new Set<MenuSection>()
  const all = () => ['tech', 'purchase', 'production'].forEach((s) => out.add(s as MenuSection))
  if (isLeaderLike(ctx)) {
    out.add('overview')
    all()
  }
  if (ctx.pmOf.size) all()
  if (inDept(ctx, 'TECH')) out.add('tech')
  if (inDept(ctx, 'PURCHASE')) {
    out.add('purchase')
    out.add('kitting')
  }
  if (inDept(ctx, 'PRODUCTION') || has(ctx, 'OUTSOURCE_COORDINATOR')) {
    out.add('production')
    out.add('releases')
  }
  if (inDept(ctx, 'QUALITY')) out.add('production')
  if (isFinance(ctx)) out.add('payments')
  const order: MenuSection[] = ['overview', 'tech', 'purchase', 'production', 'kitting', 'releases', 'payments']
  return order.filter((s) => out.has(s))
}

/** 给前端的权限标志（不含"该工单项目经理""该工序责任人"这类按对象判断的部分，前端用 pmOf / 本人 ID 补上；后端仍是最终判断） */
export function permissionFlags(ctx: RoleContext) {
  return {
    drawing: canOperate(ctx, 'drawing'),
    release: canOperate(ctx, 'release'),
    purchase: canOperate(ctx, 'purchase'),
    payment: canOperate(ctx, 'payment'),
    route: canOperate(ctx, 'route'),
    stepAction: canOperate(ctx, 'stepAction'),
    seeAmount: canSeeAmount(ctx, null),
    mobileSend: canSeeMobileSend(ctx),
    overview: canSeeOverview(ctx),
    /** 总计划：项目部、管理员（该工单项目经理由前端用 pmOf 补上） */
    plan: canOperate(ctx, 'plan'),
    planTemplate: canOperate(ctx, 'planTemplate'),
  }
}
