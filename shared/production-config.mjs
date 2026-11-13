/** Shared by the startup guard and deployment preflight; diagnostics never contain values. */
export function productionConfigErrors(env) {
  const errors = []
  const required = key => {
    const value = env[key] ?? ''
    if (!value || /CHANGE_ME|<[^>]+>/.test(value)) errors.push(key)
    return value
  }
  const url = (key, protocols) => {
    try {
      const value = new URL(required(key))
      if (!protocols.includes(value.protocol)) throw new Error()
      return value
    } catch { errors.push(key); return null }
  }
  if (env.FT_DEPLOYMENT_MODE !== 'production') errors.push('FT_DEPLOYMENT_MODE')
  const db = url('DATABASE_URL', ['mysql:'])
  if (db && (!db.username || !db.password || db.username === 'root' || !/^\/[a-z0-9_]+$/i.test(db.pathname) || /(^|_)(demo|test|sandbox)(_|$)/i.test(db.pathname.slice(1)))) errors.push('DATABASE_URL')
  for (const key of ['NUXT_DEV_TOOLS', 'NUXT_ISOLATED_DEMO', 'NUXT_SANDBOX']) {
    if (!['0', 'false'].includes(String(env[key] ?? '').toLowerCase())) errors.push(key)
  }
  if (!['1', 'true'].includes(String(env.NUXT_QMS_SYNC_ENABLED))) errors.push('NUXT_QMS_SYNC_ENABLED')
  required('NUXT_QMS_CLIENT_ID')
  if (required('NUXT_QMS_CLIENT_SECRET').length < 32) errors.push('NUXT_QMS_CLIENT_SECRET')
  const api = url('NUXT_QMS_API_BASE', ['http:', 'https:'])
  if (api && (api.username || api.password || api.search || api.hash)) errors.push('NUXT_QMS_API_BASE')
  for (const key of ['NUXT_QMS_AUTHORIZE_URL', 'NUXT_QMS_CALLBACK_URL']) {
    const target = url(key, ['https:'])
    if (target && (target.username || target.password || target.hostname === 'localhost' || target.hostname === '127.0.0.1' || (key.endsWith('CALLBACK_URL') && (target.search || target.hash || target.pathname !== '/auth/callback')))) errors.push(key)
  }
  if (!required('NUXT_ADMIN_USER_IDS').split(',').every(id => id.trim())) errors.push('NUXT_ADMIN_USER_IDS')
  if (required('NUXT_UPLOAD_DIR') !== '/app/data/uploads') errors.push('NUXT_UPLOAD_DIR')
  return [...new Set(errors)]
}
