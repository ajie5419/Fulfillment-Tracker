/** 手机打开首页时进入手机端（/m）。 */
export default defineNuxtRouteMiddleware((to) => {
  if (to.path !== '/') return
  const ua = import.meta.server ? (useRequestHeaders(['user-agent'])['user-agent'] ?? '') : navigator.userAgent
  if (/Mobile|Android|iPhone|MicroMessenger/i.test(ua)) return navigateTo('/m', { replace: true })
})
