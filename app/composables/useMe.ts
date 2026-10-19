export interface Me {
  id: string
  name: string
  department: string | null
  roleName: string | null
  /** 是否开启演示工具（NUXT_DEV_TOOLS=1） */
  devTools: boolean
  /** 管理员（NUXT_ADMIN_USER_IDS），可进设置页 */
  isAdmin: boolean
  /** 担任负责人的部门（异常列表默认筛"本部门"） */
  deptHeadOf: string[]
  /** 通知角色：OUTSOURCE_COORDINATOR / DEPT_HEAD / PROJECT_DEPT_HEAD / LEADER / FINANCE */
  roles: string[]
  /** 只能看自己负责的工单（项目经理） */
  limited: boolean
  /** 业务部门（QMS 部门经设置页"部门对照"换算；null = 其他部门） */
  businessDept: string | null
  businessDeptName: string | null
  /** 担任项目经理的工单 */
  pmOf: string[]
  /** 电脑端菜单可见分区（权限方案 R13 第二节）：overview / tech / purchase / production / kitting / releases / payments */
  menu: string[]
  /** 按角色的操作权限（不含"该工单项目经理""该工序责任人"，用 canDo 补上）。后端仍是最终判断 */
  can: {
    drawing: boolean
    release: boolean
    purchase: boolean
    payment: boolean
    route: boolean
    stepAction: boolean
    seeAmount: boolean
    mobileSend: boolean
    overview: boolean
  }
}

export function useMe() {
  return useFetch<Me>('/api/me', { key: 'me' })
}

export type Operation = 'drawing' | 'release' | 'purchase' | 'payment' | 'route' | 'stepAction'

/**
 * 当前用户能不能做某个操作（只用来隐藏 / 禁用按钮，后端 403 才是最终判断）。
 * 与 server/services/auth/permissions.ts 的 canOperate 一致：
 *   采购行、付款申请、工件工序编辑：该工单项目经理也可以；开工/完工/发出/返厂：该工序责任人也可以。
 */
export function canDo(me: Me | null | undefined, op: Operation, target: { workOrderNumber?: string | null; ownerId?: string | null } = {}): boolean {
  if (!me) return false
  if (me.isAdmin || me.can?.[op]) return true
  const pm = !!target.workOrderNumber && !!me.pmOf?.includes(target.workOrderNumber)
  if (op === 'purchase' || op === 'payment' || op === 'route') return pm
  if (op === 'stepAction') return !!target.ownerId && target.ownerId === me.id
  return false
}

/** 是否可能在某些工单上有该操作的权限（列表页顶部"新建/导入"按钮：本人是任何工单的项目经理也显示） */
export function canDoAny(me: Me | null | undefined, op: Operation): boolean {
  if (!me) return false
  if (me.isAdmin || me.can?.[op]) return true
  return (op === 'purchase' || op === 'payment' || op === 'route') && !!me.pmOf?.length
}

/** 退出并回到 QMS 登录页重新输入账号密码（可换人登录）。不带 prompt=login 的话，QMS 已登录时会直接以原账号再登录进来 */
export async function logout() {
  await $fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth/login?prompt=login'
}
