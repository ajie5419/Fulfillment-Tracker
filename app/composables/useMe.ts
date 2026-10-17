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
  /** 通知角色：OUTSOURCE_COORDINATOR / DEPT_HEAD / PROJECT_DEPT_HEAD / LEADER */
  roles: string[]
  /** 只能看自己负责的工单（项目经理） */
  limited: boolean
}

export function useMe() {
  return useFetch<Me>('/api/me', { key: 'me' })
}

export async function logout() {
  await $fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth/login'
}
