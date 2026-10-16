/** 会话过期后接口返回 401：整页跳去登录，登录完回到当前页面。 */
export default defineNuxtPlugin(() => {
  globalThis.$fetch = $fetch.create({
    onResponseError({ response }) {
      if (response.status === 401) {
        const here = window.location.pathname + window.location.search
        window.location.href = `/auth/login?redirect=${encodeURIComponent(here)}`
      }
    },
  })
})
