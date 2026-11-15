#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { buildLocalImage, ensureMysql, kiri, kiriProgress, mysqlSql } from './kiri-mysql.mjs'

process.chdir(resolve(import.meta.dirname, '..'))
const image = 'ft-local:demo'
const compose = ['compose', '--env-file', '/dev/null', '-p', 'ft-demo', '-f', 'docker-compose.demo.yml']
const network = 'ft-demo'
let stage = '检查 Kiri 和本地证书'

async function assertPortsAvailable() {
  for (const port of [3101, 4101]) await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

try {
  const exists = kiri(['ps', '-a', '--format', '{{.Names}}']).trim().split('\n').includes('ft-demo-app')
  if (exists) {
    const label = kiri(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', 'ft-demo-app']).trim()
    if (label !== 'ft-demo') throw new Error('Existing app is not owned by this launcher')
  }
  if (process.argv.includes('--stop')) {
    if (exists) kiri(['stop', 'ft-demo-app'])
    console.log('演示应用容器已停止，数据库和附件保留。')
  } else {
    for (const path of ['certs/localhost.pem', 'certs/localhost-key.pem']) if (!existsSync(path)) throw new Error('Local certificates are required')
    if (process.argv.includes('--check')) {
      await ensureMysql('demo', { checkOnly: true })
      console.log('Kiri 演示数据库和证书检查通过；未创建或启动服务。')
    } else {
      if (!exists) await assertPortsAvailable()
      stage = '构建容器内的前后端'
      await buildLocalImage(image)
      stage = '准备独立演示数据库和网络'
      await ensureMysql('demo')
      const networks = kiri(['network', 'ls', '--format', '{{.Name}}']).trim().split('\n')
      if (!networks.includes(network)) kiri(['network', 'create', '--label', 'app.fulfillment.demo=1', network])
      const owner = kiri(['network', 'inspect', '--format', '{{index .Labels "app.fulfillment.demo"}}', network]).trim()
      if (owner !== '1') throw new Error('Existing network is not owned by the demo')
      const attached = JSON.parse(kiri(['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'ft-demo-mysql']))
      if (!Object.hasOwn(attached, network)) kiri(['network', 'connect', network, 'ft-demo-mysql'])
      // Build first; stop the old app only when its replacement and database are ready.
      if (exists) kiri(['stop', 'ft-demo-app'])
      await assertPortsAvailable()
      const password = randomBytes(24).toString('hex')
      const secret = randomBytes(32).toString('hex')
      mysqlSql('demo', `CREATE DATABASE IF NOT EXISTS fulfillment_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'fulfillment_demo'@'%' IDENTIFIED BY '${password}';
ALTER USER 'fulfillment_demo'@'%' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON fulfillment_demo.* TO 'fulfillment_demo'@'%';`)
      mkdirSync('.data/demo/uploads', { recursive: true })
      const env = {
        FT_LOCAL_IMAGE: image,
        FT_DEMO_DATABASE_URL: `mysql://fulfillment_demo:${password}@ft-demo-mysql:3306/fulfillment_demo`,
        FT_DEMO_BRIDGE_SECRET: secret,
        FT_DEMO_KEEP_DATA: process.argv.includes('--keep-data') ? '1' : '0',
      }
      stage = '启动应用容器并等待健康检查'
      await kiriProgress([...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120'], env, [password, secret])
      console.log('Docker 演示环境已启动：https://127.0.0.1:3101；前端、后端和模拟登录均在 ft-demo-app 容器中。')
    }
  }
} catch {
  console.error(`演示环境操作失败：${stage}。检查 Kiri、3101/4101 端口和容器日志；数据库及附件未删除。`)
  process.exitCode = 1
}
