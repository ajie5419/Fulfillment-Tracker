function validCallback(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.search && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

/** 启动时检查必填配置，缺了直接报错退出，避免带着空密钥运行。 */
export default defineNitroPlugin(() => {
  const cfg = useRuntimeConfig()
  const missing: string[] = []
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!cfg.qms.authorizeUrl) missing.push('NUXT_QMS_AUTHORIZE_URL')
  if (cfg.qms.clientSecret.length < 32) missing.push('NUXT_QMS_CLIENT_SECRET（≥32 位，与 QMS 一致）')
  if (!validCallback(cfg.qms.callbackUrl)) missing.push('NUXT_QMS_CALLBACK_URL（必须 https，且不带 ? 和 #）')
  if (missing.length) {
    throw new Error(`[fulfillment] 缺少或不合法的配置：${missing.join('、')}`)
  }
})
