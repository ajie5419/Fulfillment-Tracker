export interface Me {
  id: string
  name: string
  department: string | null
  roleName: string | null
  /** 是否开启演示工具（NUXT_DEV_TOOLS=1） */
  devTools: boolean
  /** 管理员（NUXT_ADMIN_USER_IDS），可进设置页 */
  isAdmin: boolean
}

export function useMe() {
  return useFetch<Me>('/api/me', { key: 'me' })
}

export async function logout() {
  await $fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth/login'
}
