import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { startMockIdentityBridge } from './mock-identity-bridge.mjs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createServer as createPortProbe } from 'node:net'
import { SandboxGuardError, validateSandboxConfig, assertSandboxIdentity, sandboxMigrationState, assertSandboxCurrent, migrateSandbox } from './sandbox-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
process.chdir(ROOT)
mkdirSync('logs', { recursive: true })
const ENV = '.env.sandbox'
const ACCOUNT = 'sandbox-pm'
const ORDER = 'SANDBOX-ONLY-001'
const HOST = process.env.SANDBOX_HOST ?? (existsSync(ENV) ? /^SANDBOX_HOST=(.+)$/m.exec(readFileSync(ENV, 'utf8'))?.[1] : '127.0.0.1')
if (!HOST || !/^(127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(HOST)) throw new Error('Private sandbox host required')
const PORT = 3110
const BRIDGE_PORT = 4111
const PROXY_PORT = 4110
const CALLBACK = `https://${HOST}:${PORT}/auth/callback`
function sql(query) {
  return execFileSync('container', ['exec', '-i', 'qms-container-mysql', 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --batch --skip-column-names'], { input: query, encoding: 'utf8' })
}
function config() {
  const env = Object.fromEntries(readFileSync(ENV, 'utf8').trim().split('\n').map(line => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
  validateSandboxConfig(env, HOST)
  return env
}

async function checkIdentity(db, env) {
  const [identity] = await db.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS account')
  const target = validateSandboxConfig(env, HOST)
  assertSandboxIdentity(target, identity)
  return target
}

async function pendingMigrations(db) {
  const expected = readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  let rows
  try { rows = await db.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations') }
  catch { throw new SandboxGuardError('无法读取沙盒迁移记录。请核对专用库及其迁移历史；不要重新 init 或清库。') }
  return sandboxMigrationState(expected, rows)
}

const deployMigrations = env => execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })

async function assertPortsFree() {
  for (const [host, port] of [[HOST, PORT], ['127.0.0.1', PROXY_PORT], ['127.0.0.1', BRIDGE_PORT]]) {
    await new Promise((accept, reject) => {
      const probe = createPortProbe()
      probe.once('error', () => reject(new SandboxGuardError(`沙盒端口 ${port} 已占用。请先停止原沙盒服务，再启动或升级。`)))
      probe.listen(port, host, () => probe.close(accept))
    })
  }
}
function baseline() {
  const result = sql('SELECT COUNT(*) FROM fulfillment.qms_work_order; SELECT COUNT(*) FROM fulfillment.qms_user;')
  console.log('Original read-only counts:', result.trim().split('\n').join(' / '))
  return result
}
async function init() {
  if (existsSync(ENV)) throw new Error('Configuration exists; refusing to initialize again')
  const before = baseline()
  const suffix = Date.now().toString()
  const database = `fulfillment_sandbox_${suffix}`
  const username = `ft_sb_${suffix}`
  if (sql(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${database}';`).trim() !== '0') throw new Error('Database already exists')
  const password = randomBytes(32).toString('hex')
  const secret = randomBytes(32).toString('hex')
  sql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER '${username}'@'%' IDENTIFIED BY '${password}'; GRANT SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* TO '${username}'@'%';`)
  mkdirSync('certs', { recursive: true })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'certs/sandbox-key.pem', '-out', 'certs/sandbox.pem', '-days', '30', '-subj', '/CN=Fulfillment Sandbox', '-addext', `subjectAltName=IP:${HOST}`], { stdio: 'ignore' })
  const env = {
    DATABASE_URL: `mysql://${username}:${password}@127.0.0.1:3307/${database}`,
    SANDBOX_DATABASE: database, SANDBOX_HOST: HOST,
    NUXT_SANDBOX: '1', NUXT_DEV_TOOLS: '0', NUXT_QMS_SYNC_ENABLED: '0',
    NUXT_ADMIN_USER_IDS: ACCOUNT,
    NUXT_QMS_API_BASE: `http://127.0.0.1:${PROXY_PORT}`,
    NUXT_QMS_AUTHORIZE_URL: `https://${HOST}:${PORT}/auth/sandbox-authorize`,
    NUXT_QMS_CLIENT_ID: 'fulfillment-sandbox', NUXT_QMS_CLIENT_SECRET: secret,
    NUXT_QMS_CALLBACK_URL: CALLBACK,
    DEV_HTTPS_KEY: resolve('certs/sandbox-key.pem'), DEV_HTTPS_CERT: resolve('certs/sandbox.pem'),
  }
  writeFileSync(ENV, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  const checked = config()
  const db = new PrismaClient({ datasourceUrl: checked.DATABASE_URL })
  try {
    const target = await checkIdentity(db, checked)
    await migrateSandbox({ target, executeSql: sql, migrate: () => deployMigrations(checked) })
    if (await db.qmsWorkOrder.count() !== 0 || await db.qmsUser.count() !== 0) throw new Error('Seed guard failed')
    const now = new Date()
    const deliveryDate = new Date(now.getTime() + 30 * 86400000)
    await db.$transaction(async tx => {
      await tx.qmsDepartment.create({ data: { id: 'sandbox-project', name: '测试项目部', parentId: '0', status: 1, updatedAt: now } })
      await tx.qmsUser.create({ data: { id: ACCOUNT, username: ACCOUNT, realName: '【独立测试】项目经理', departmentId: 'sandbox-project', status: 'ACTIVE', updatedAt: now } })
      await tx.qmsProcess.create({ data: { id: 'sandbox-process', name: '合成装配工序', status: 1, updatedAt: now } })
      await tx.qmsWorkOrder.create({ data: { workOrderNumber: ORDER, customerName: '【合成】测试客户', projectName: '【独立测试】唯一工单', quantity: 1, version: 1, deliveryDate, status: 'IN_PROGRESS', updatedAt: now } })
      await tx.workOrderExt.create({ data: { workOrderNumber: ORDER, projectManagerId: ACCOUNT } })
      await tx.part.create({ data: { workOrderNumber: ORDER, name: '【合成】测试工件', quantity: 1, steps: { create: { seq: 1, processId: 'sandbox-process', mode: 'SELF', ownerId: ACCOUNT, planStartDate: now, dueDate: deliveryDate } } } })
    })
    console.log('Created:', '127.0.0.1:3307/' + database, 'orders:', await db.qmsWorkOrder.count(), 'users:', await db.qmsUser.count())
    for (const table of ['fulfillment.qms_work_order', 'quality_guard_local_test.users']) {
      try { await db.$queryRawUnsafe(`SELECT COUNT(*) FROM ${table}`); throw new Error('Unexpected cross-database access') }
      catch (error) { if (error.message === 'Unexpected cross-database access') throw error; if (!String(error.message).includes('denied')) throw error; console.log('Cross-database access denied:', table) }
    }
  } finally { await db.$disconnect() }
  writeFileSync('logs/original-counts-before.txt', before, { mode: 0o600 })
  baseline()
}
async function start() {
  const env = config()
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL })
  try {
    await checkIdentity(db, env)
    assertSandboxCurrent(await pendingMigrations(db))
    if (await db.qmsWorkOrder.count() !== 1 || !await db.qmsUser.findUnique({ where: { id: ACCOUNT }, select: { id: true } })) throw new Error('Runtime database identity/count guard failed')
  } finally { await db.$disconnect() }
  await assertPortsFree()
  const bridge = await startMockIdentityBridge({ host: '127.0.0.1', port: BRIDGE_PORT, clientId: env.NUXT_QMS_CLIENT_ID, clientSecret: env.NUXT_QMS_CLIENT_SECRET, callback: CALLBACK, users: { [ACCOUNT]: { name: '【独立测试】项目经理', active: true } }, defaultUserId: ACCOUNT, chooser: true, sync: false })
  const proxy = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://stub').pathname
    const allowed = (req.method === 'GET' && path === '/identity/authorize') || (req.method === 'POST' && ['/api/identity-bridge/exchange', '/api/identity-bridge/identity', '/api/identity-bridge/revoke'].includes(path))
    if (!allowed) {
      console.log('Stub rejected non-identity operation:', req.method, path)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ code: -1, data: null, error: { code: 'SANDBOX_WRITE_DISABLED' }, message: '独立单工单测试：QMS 业务写回与同步已禁用，未执行任何远端操作' }))
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await fetch(bridge.url + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, redirect: 'manual' })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(502); res.end('Sandbox identity bridge unavailable') }
  })
  await new Promise((accept, reject) => { proxy.once('error', reject); proxy.listen(PROXY_PORT, '127.0.0.1', accept) })
  const child = spawn('node_modules/.bin/nuxt', ['dev', '--dotenv', ENV, '--host', HOST, '--port', String(PORT), '--no-fork'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const redact = chunk => String(chunk).replace(/([?&](?:code|state)=)[^&\s"'<>]+/g, '$1[redacted]')
  createInterface({ input: child.stdout }).on('line', line => console.log(redact(line)))
  createInterface({ input: child.stderr }).on('line', line => console.error(redact(line)))
  const stop = () => { child.kill('SIGTERM'); proxy.close(); void bridge.close() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  child.on('exit', code => { proxy.close(); void bridge.close(); process.exitCode = code ?? 1 })
  console.log(`SANDBOX ONLY: https://${HOST}:${PORT}; account: 【独立测试】项目经理; order: ${ORDER}; QMS writes disabled`)
}

async function upgrade() {
  const env = config()
  await assertPortsFree()
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL })
  try {
    const target = await checkIdentity(db, env)
    const pending = await pendingMigrations(db)
    if (!pending.length) { console.log('沙盒数据库已是当前版本，无需升级。'); return }
    if (await db.qmsWorkOrder.count() !== 1 || !await db.qmsUser.findUnique({ where: { id: ACCOUNT }, select: { id: true } })) throw new SandboxGuardError('沙盒数据身份校验失败，未执行升级；请核对现有测试库。')
    await migrateSandbox({ target, executeSql: sql, migrate: () => deployMigrations(env) })
    assertSandboxCurrent(await pendingMigrations(db))
    console.log(`沙盒数据库升级完成（${pending.length} 项），已撤销临时迁移权限；原有数据保留，可执行 node scripts/sandbox.mjs start。`)
  } finally { await db.$disconnect() }
}

try {
  if (process.argv[2] === 'init') await init()
  else if (process.argv[2] === 'start') await start()
  else if (process.argv[2] === 'upgrade') await upgrade()
  else if (process.argv[2] === 'counts') baseline()
  else throw new SandboxGuardError('Usage: node scripts/sandbox.mjs init|start|upgrade|counts')
} catch (error) {
  if (error instanceof SandboxGuardError) console.error(error.message)
  else console.error('Sandbox operation failed:', error.name, error.code ?? error.status ?? 'guard', '(credential-bearing exception details withheld)')
  process.exitCode = 1
}
