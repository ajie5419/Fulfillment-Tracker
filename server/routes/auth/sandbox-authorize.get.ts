export default defineEventHandler(async (event) => {
  if (process.env.NUXT_SANDBOX !== '1') throw createError({ statusCode: 404 })
  const query = getRequestURL(event).search
  const response = await fetch(`http://127.0.0.1:4110/identity/authorize${query}`, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (response.status === 302 && location) {
    const callback = new URL(location)
    const expected = new URL(String(useRuntimeConfig(event).qms.callbackUrl))
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw createError({ statusCode: 502 })
    return sendRedirect(event, location, 302)
  }
  setResponseStatus(event, response.status)
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  return (await response.text()).replaceAll('/identity/authorize?', '/auth/sandbox-authorize?')
})
