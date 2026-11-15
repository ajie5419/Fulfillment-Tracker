import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureMysql, mysqlSql } from './kiri-mysql.mjs'

process.chdir(resolve(import.meta.dirname, '..'))
const lock = '.data/kiri-test.lock'
let locked = false
try {
  mkdirSync('.data', { recursive: true })
  // All worktrees share the named test container; the engine-side lock prevents concurrent destructive suites.
  const target = await ensureMysql('test')
  mysqlSql('test', `CREATE DATABASE IF NOT EXISTS ${target.database};`)
  const { PrismaClient } = await import('@prisma/client')
  const password = randomBytes(24).toString('hex')
  // A host lock provides an early, actionable failure; the MySQL advisory lock below covers other worktrees.
  mkdirSync(lock)
  locked = true
  const username = `ft_test_${randomBytes(6).toString('hex')}`
  mysqlSql('test', `CREATE USER '${username}'@'%' IDENTIFIED BY '${password}'; GRANT ALL PRIVILEGES ON ${target.database}.* TO '${username}'@'%';`)
  const url = `mysql://${username}:${password}@127.0.0.1:${target.port}/${target.database}`
  // The advisory lock must stay on one connection; test clients retain their normal transaction pools.
  const db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` })
  try {
    const [result] = await db.$queryRawUnsafe("SELECT GET_LOCK('fulfillment_test_suite', 0) AS acquired")
    if (Number(result.acquired) !== 1) throw new Error('Another integration suite is running')
    const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, REQUIRE_TEST_DATABASE: '1' }
    // Capture output because driver failures may include connection strings; print only redacted text.
    for (const args of [['exec', 'prisma', 'migrate', 'deploy'], ['test:integration']]) {
      try {
        const output = execFileSync('pnpm', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
        console.log(output.replaceAll(url, '[test database]').replaceAll(password, '[redacted]'))
      } catch (error) {
        console.error(String(error.stdout ?? '').replaceAll(url, '[test database]').replaceAll(password, '[redacted]'))
        console.error(String(error.stderr ?? '').replaceAll(url, '[test database]').replaceAll(password, '[redacted]'))
        throw new Error('Kiri integration checks failed')
      }
    }
  } finally {
    await db.$disconnect()
    mysqlSql('test', `DROP USER IF EXISTS '${username}'@'%';`)
  }
} catch {
  console.error('Kiri 集成测试失败：请检查 Kiri、专用测试容器和测试输出；若上次进程被强制终止，确认没有测试运行后移除 .data/kiri-test.lock。')
  process.exitCode = 1
} finally {
  if (locked) rmdirSync(lock)
}
