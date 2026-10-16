export interface Me {
  id: string
  name: string
  department: string | null
  roleName: string | null
}

export function useMe() {
  return useFetch<Me>('/api/me', { key: 'me' })
}

export async function logout() {
  await $fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth/login'
}
