#!/usr/bin/env node
/** Isolated local demo: never loads .env or connects to the configured QMS. */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startMockIdentityBridge } from './mock-identity-bridge.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const database = 'fulfillment_demo'
const databaseUser = 'fulfillment_demo'
const appPort = 3101
const bridgePort = 4101
// A different host also isolates cookies from the existing localhost:3100 app.
const origin = `https://127.0.0.1:${appPort}`
const containerName = 'qms-container-mysql'
const publicCert = resolve('certs/localhost.pem')
const privateKey = resolve('certs/localhost-key.pem')
let stage = '检查文件和端口'

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用，未启动演示环境。`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

async function main() {
  if (!existsSync('.output/server/index.mjs')) throw new Error('请先执行 pnpm build。')
  if (!existsSync(publicCert) || !existsSync(privateKey)) throw new Error('缺少本地 HTTPS 证书，请先完成本地证书配置。')
  await Promise.all([assertPortFree(appPort), assertPortFree(bridgePort)])
  if (process.argv.includes('--check')) {
    console.log(`演示入口 ${origin}；数据库 ${database}；模拟登录端口 ${bridgePort}。文件及端口检查通过，未写数据库、未启动服务。`)
    return
  }

  const password = randomBytes(24).toString('hex')
  const bridgeSecret = randomBytes(32).toString('hex')
  stage = '创建独立数据库账号（需要访问本机容器）'
  // Credentials travel over stdin and process memory, never command arguments or logs.
  // This account can access only the dedicated demo schema, not the existing database.
  execFileSync('container', ['exec', '-i', containerName, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot'], {
    input: `CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${databaseUser}'@'%' IDENTIFIED BY '${password}';
ALTER USER '${databaseUser}'@'%' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON ${database}.* TO '${databaseUser}'@'%';\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  // Remove inherited app overrides before supplying a complete isolated configuration.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NUXT_') || key.startsWith('NITRO_') || key.startsWith('DEV_HTTPS_')) delete process.env[key]
  }
  Object.assign(process.env, {
    DATABASE_URL: `mysql://${databaseUser}:${password}@127.0.0.1:3307/${database}`,
    NODE_ENV: 'production',
    FT_DEPLOYMENT_MODE: 'demo',
    NUXT_DEV_TOOLS: '1',
    NUXT_ISOLATED_DEMO: '1',
    NUXT_ADMIN_USER_IDS: 'u-005',
    NUXT_UPLOAD_DIR: resolve('.data/demo/uploads'),
    NUXT_QMS_API_BASE: `http://127.0.0.1:${bridgePort}`,
    NUXT_QMS_AUTHORIZE_URL: `http://127.0.0.1:${bridgePort}/identity/authorize`,
    NUXT_QMS_CLIENT_ID: 'fulfillment-demo',
    NUXT_QMS_CLIENT_SECRET: bridgeSecret,
    NUXT_QMS_CALLBACK_URL: `${origin}/auth/callback`,
    NUXT_QMS_SYNC_ENABLED: '0',
    HOST: '127.0.0.1',
    PORT: String(appPort),
  })
  console.log('正在准备独立演示数据库…')
  stage = '迁移独立演示数据库'
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: process.env, stdio: ['ignore', 'ignore', 'ignore'] })
  const require = createRequire(import.meta.resolve('nuxt'))
  const { createJiti } = require('jiti')
  const jiti = createJiti(import.meta.url)
  const { prisma } = await jiti.import(resolve('server/utils/prisma.ts'))
  const { seedDemo } = await jiti.import(resolve('server/services/dev/demo.ts'))
  stage = '检查并写入演示数据'
  const foreign = await prisma.qmsWorkOrder.count({ where: { NOT: { workOrderNumber: { startsWith: 'DEMO-' } } } })
  if (foreign) throw new Error('演示库中存在非演示工单，已停止，未清除任何记录。')
  if (!process.argv.includes('--keep-data')) await seedDemo()
  stage = '修复演示身份配置及计划接收待办'
  const { repairIsolatedDemo } = await jiti.import(resolve('server/services/dev/repair-isolated-demo.ts'))
  const repaired = await repairIsolatedDemo()
  if (repaired.created) console.log(`已补齐演示账号身份配置，补发 ${repaired.created} 条计划接收待办。`)
  const users = await prisma.qmsUser.findMany({ where: { username: { startsWith: 'DEMO-' }, isDeleted: false, status: 'ACTIVE' }, select: { id: true, realName: true } })
  const count = await prisma.qmsWorkOrder.count()
  await prisma.$disconnect()
  mkdirSync(process.env.NUXT_UPLOAD_DIR, { recursive: true })
  stage = '启动模拟登录和 HTTPS 服务'
  await startMockIdentityBridge({
    port: bridgePort,
    host: '127.0.0.1',
    clientId: 'fulfillment-demo',
    clientSecret: bridgeSecret,
    callback: `${origin}/auth/callback`,
    chooser: true,
    sync: false,
    users: Object.fromEntries(users.map(user => [user.id, { name: user.id === 'u-005' ? '演示管理员 / 分管领导' : user.realName, active: true }])),
  })
  // TLS material is supplied only to the local HTTPS server and never printed.
  process.env.NITRO_SSL_CERT = readFileSync(publicCert, 'utf8')
  process.env.NITRO_SSL_KEY = readFileSync(privateKey, 'utf8')
  await import(pathToFileURL(resolve('.output/server/index.mjs')).href)
  console.log(`独立演示环境已启动：${origin}（${count} 个演示工单）。选择“演示管理员 / 分管领导”可查看全部模块。`)
}

main().catch((error) => {
  // Driver/child-process errors can contain connection credentials; do not dump them.
  const code = error?.code ?? error?.errorCode
  if (typeof code === 'string' && /^(P\d{4}|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND)$/.test(code)) {
    console.error(`演示启动错误码：${code}`)
    if (code === 'P2028') console.error('数据库事务启动或执行超时。请检查数据库负载和锁等待；不要清空演示数据，也不要重复并发启动。')
  }
  console.error(`演示环境准备失败：${stage}。请检查构建产物、端口、本地证书及 qms-container-mysql 容器；未删除原环境数据。`)
  process.exit(1)
})
