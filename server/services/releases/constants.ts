/** 发放签收（R9）的常量与纯函数：文案、编号、按"部门 + 角色"选人、设计变更影响的工序。不碰数据库，便于单测。 */
import type { NotifyRoleKind, ReceiptStatus, ReleaseType, StepStatus } from '@prisma/client'
import { shanghaiDay } from '../alerts/rules'

export const TYPE_TEXT: Record<ReleaseType, string> = { DRAWING: '图纸', CHANGE: '设计变更', PROCESS: '工艺文件' }
export const STEP_STATUS_TEXT: Record<StepStatus, string> = { PENDING: '待开工', OUT: '在外加工', IN_PROGRESS: '加工中', DONE: '已完成', BLOCKED: '有异常' }
export const RECEIPT_STATUS_TEXT: Record<ReceiptStatus, string> = { PENDING: '待签收', SIGNED: '已签收', REJECTED: '已拒收', CANCELLED: '已作废' }

/** 待办：接收人签收（refType = receipt，refId = 签收记录 ID） */
export const SIGN_RELEASE = 'SIGN_RELEASE'
/** 待办：生产经理、外协专员确认设计变更影响（refType = release，refId = 发放单 ID） */
export const CONFIRM_CHANGE = 'CONFIRM_CHANGE'

/** "生产经理" = 生产部的部门负责人（notify_role 里 DEPT_HEAD + 部门名称"生产部"，与异常默认责任部门一致） */
export const PRODUCTION_DEPT = '生产部'

export const ROLE_TEXT: Record<NotifyRoleKind, string> = {
  OUTSOURCE_COORDINATOR: '外协专员',
  DEPT_HEAD: '部门负责人',
  PROJECT_DEPT_HEAD: '项目部负责人',
  LEADER: '分管领导',
  FINANCE: '财务',
}

/** 一次发放最多多少接收人（防误选"全部人员"时一下发几百条待办） */
export const MAX_RECIPIENTS = 200
/** 附件最多几个 */
export const MAX_ATTACHMENTS = 5

/** 编号前缀：FF-YYMMDD-（工厂时区当天）。序号格式与异常编号相同（至少 3 位） */
export function releaseNoPrefix(now: Date): string {
  return `FF-${shanghaiDay(now).slice(2).replaceAll('-', '')}-`
}

// ───────────── 按"部门 + 角色"选人 ─────────────

/** 部门 + 角色：只填部门 = 该部门全部在职人员；只填角色 = 全公司担任该角色的人；都填 = 该部门里担任该角色的人 */
export interface RecipientGroup {
  department?: string | null
  role?: NotifyRoleKind | null
}

export interface GroupContext {
  /** 在职、未删除的用户，部门已换成名称（没有部门的 deptName 为 null） */
  users: { id: string; deptName: string | null }[]
  /** 通知角色（设置页"通知对象"）；部门负责人的 department 是部门名称 */
  roles: { role: NotifyRoleKind; userId: string; department: string | null }[]
}

export function groupLabel(g: RecipientGroup): string {
  return [g.department, g.role ? ROLE_TEXT[g.role] : '全部人员'].filter(Boolean).join(' · ')
}

/**
 * 把一个"部门 + 角色"展开成人（建发放单时一次性展开，之后部门调整不影响已发的）。
 * 部门负责人按 notify_role.department 对应（与预警升级口径一致）；其他角色按本人所在部门过滤。
 * 不在职（不在 ctx.users 里）的人跳过。
 */
export function resolveGroup(g: RecipientGroup, ctx: GroupContext): string[] {
  const dept = g.department?.trim() || null
  const active = new Map(ctx.users.map((u) => [u.id, u]))
  let ids: string[]
  if (!g.role) {
    ids = dept ? ctx.users.filter((u) => u.deptName === dept).map((u) => u.id) : []
  } else if (g.role === 'DEPT_HEAD') {
    ids = ctx.roles.filter((r) => r.role === 'DEPT_HEAD' && (!dept || r.department === dept)).map((r) => r.userId)
  } else {
    ids = ctx.roles.filter((r) => r.role === g.role && (!dept || active.get(r.userId)?.deptName === dept)).map((r) => r.userId)
  }
  return [...new Set(ids.filter((id) => active.has(id)))]
}

// ───────────── 设计变更影响 ─────────────

/**
 * 设计变更关联工件的工序分两类：
 *   started = 已在加工或在外协（加工中、在外加工）→ 要给生产经理、外协专员发"确认变更影响"待办；
 *   hold = 还没开工（待开工）→ 标"等变更"，W2/W3 暂停计时，变更影响确认后解除。
 * 已完成、有异常的不动（有异常已经有异常单在跟）。
 */
export function splitAffectedSteps<T extends { status: StepStatus }>(steps: T[]): { started: T[]; hold: T[] } {
  return {
    started: steps.filter((s) => s.status === 'IN_PROGRESS' || s.status === 'OUT'),
    hold: steps.filter((s) => s.status === 'PENDING'),
  }
}

/** 发放单 partIds（JSON）→ 字符串数组 */
export function partIdsOf(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : []
}

/** 电脑端发放单详情地址；手机端对应 /m/release */
export const releaseLink = (id: string) => `/releases?id=${encodeURIComponent(id)}`
export const releaseMobileLink = (id: string) => `/m/release?id=${encodeURIComponent(id)}`
