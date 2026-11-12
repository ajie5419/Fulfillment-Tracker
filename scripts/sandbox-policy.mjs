/** Only messages constructed here may be shown; database/child-process errors can contain credentials. */
export class SandboxGuardError extends Error {}

function assertTarget(target) {
  const suffix = /^fulfillment_sandbox_([0-9]+)$/.exec(target.database)?.[1]
  if (!suffix || target.username !== `ft_sb_${suffix}`) throw new SandboxGuardError('沙盒库和账号不匹配；仅允许初始化器创建的同编号沙盒库与账号。')
  return target
}

export function validateSandboxConfig(env, host) {
  let url
  try { url = new URL(env.DATABASE_URL) } catch { throw new SandboxGuardError('沙盒数据库配置无效，请检查专用配置；未执行升级。') }
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || url.port !== '3307' || url.search || url.hash || !url.password || env.SANDBOX_DATABASE !== url.pathname.slice(1)) {
    throw new SandboxGuardError('沙盒数据库地址校验失败；必须使用初始化器生成的本机专用配置。')
  }
  const target = assertTarget({ database: url.pathname.slice(1), username: url.username })
  if (env.SANDBOX_HOST !== host || env.NUXT_QMS_API_BASE !== 'http://127.0.0.1:4110' || env.NUXT_QMS_AUTHORIZE_URL !== `https://${host}:3110/auth/sandbox-authorize` || env.NUXT_QMS_CALLBACK_URL !== `https://${host}:3110/auth/callback`) {
    throw new SandboxGuardError('沙盒身份桥地址校验失败，请保持专用 host、授权页和回调地址一致。')
  }
  if (env.NUXT_SANDBOX !== '1' || env.NUXT_QMS_SYNC_ENABLED !== '0' || env.NUXT_DEV_TOOLS !== '0') throw new SandboxGuardError('沙盒隔离开关校验失败；必须禁用 QMS 同步和演示工具。')
  return target
}

export function assertSandboxIdentity(target, identity) {
  assertTarget(target)
  if (identity?.db !== target.database || identity?.account !== `${target.username}@%`) throw new SandboxGuardError('实际连接的数据库或账号与沙盒配置不符，已停止；未执行授权或迁移。')
}

/** Rolled-back attempts do not count as applied; unfinished or unknown migrations require explicit review. */
export function sandboxMigrationState(expected, rows) {
  const live = rows.filter(row => !row.rolled_back_at)
  if (live.some(row => !row.finished_at)) throw new SandboxGuardError('沙盒存在未完成的迁移。请先由维护人员核查并修复迁移记录，再执行 node scripts/sandbox.mjs upgrade；不要重新 init 或清库。')
  const applied = new Set(live.map(row => row.migration_name))
  if ([...applied].some(name => !expected.includes(name))) throw new SandboxGuardError('沙盒库包含当前代码没有的迁移。请先切换到匹配或更新的代码版本，禁止降级启动。')
  return expected.filter(name => !applied.has(name))
}

export function assertSandboxCurrent(pending) {
  if (pending.length) throw new SandboxGuardError(`沙盒库有 ${pending.length} 项待升级迁移。先停止沙盒服务，执行 node scripts/sandbox.mjs upgrade，再执行 node scripts/sandbox.mjs start；无需重新 init，现有数据保留。`)
}

/** Grant only schema-local DDL and revoke it even when granting or migration fails. No reset/seed is allowed here. */
export async function migrateSandbox({ target, executeSql, migrate }) {
  assertTarget(target)
  const scope = `ON \`${target.database}\`.* TO '${target.username}'@'%'`
  try {
    await executeSql(`GRANT CREATE,ALTER,INDEX,REFERENCES ${scope};`)
    await migrate()
  } finally {
    try { await executeSql(`REVOKE CREATE,ALTER,INDEX,REFERENCES ON \`${target.database}\`.* FROM '${target.username}'@'%';`) }
    catch { throw new SandboxGuardError('撤销沙盒临时迁移权限失败。请停止使用该沙盒并由维护人员核对该库账号权限；不要启动服务。') }
  }
}
