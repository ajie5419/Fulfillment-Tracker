#!/usr/bin/env node
/** Isolated local demo: never loads .env or connects to the configured QMS. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startMockIdentityBridge } from './mock-identity-bridge.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const database = 'fulfillment_demo'
const appPort = 3101
const bridgePort = 4101
// A different host also isolates cookies from the existing localhost:3100 app.
const origin = `https://127.0.0.1:${appPort}`
const publicCert = resolve('certs/localhost.pem')
const privateKey = resolve('certs/localhost-key.pem')
let stage = '检查文件和端口'

async function main() {
  if (process.env.FT_CONTAINER_DEMO !== '1') throw new Error('Container demo only')
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (url.protocol !== 'mysql:' || url.hostname !== 'ft-demo-mysql' || url.port !== '3306' || url.pathname !== '/fulfillment_demo' || url.username !== 'fulfillment_demo' || !url.password || url.search || url.hash) throw new Error('Isolated database required')
  const bridgeSecret = process.env.FT_DEMO_BRIDGE_SECRET
  if (!bridgeSecret || !/^[a-f0-9]{64}$/.test(bridgeSecret)) throw new Error('Generated bridge secret required')
  if (!existsSync('.output/server/index.mjs') || !existsSync(publicCert) || !existsSync(privateKey)) throw new Error('Missing build or TLS files')
  // Remove inherited app overrides before supplying a complete isolated configuration.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NUXT_') || key.startsWith('NITRO_') || key.startsWith('DEV_HTTPS_')) delete process.env[key]
  }
  Object.assign(process.env, {
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
    HOST: '0.0.0.0',
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
  if (process.env.FT_DEMO_KEEP_DATA !== '1') await seedDemo()
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
    host: '0.0.0.0',
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
  console.error(`演示环境准备失败：${stage}。请检查构建产物、端口、本地证书及 Kiri 中的 ft-demo-mysql 容器；未删除原环境数据。`)
  process.exit(1)
})
