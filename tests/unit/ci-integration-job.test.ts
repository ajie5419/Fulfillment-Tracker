import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

it('CI 为集成测试提供独立 MySQL 8 测试库，迁移与测试使用同一 URL', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  const job = workflow.slice(workflow.indexOf('\n  integration:'))
  expect(job).toContain('image: mysql:8.0')
  const url = job.match(/TEST_DATABASE_URL:\s*(mysql:\/\/[^\s]+)/)?.[1]
  expect(url).toBeTruthy()
  expect(getTestDatabaseUrl(url)).toBe(url)
  const steps = job.split(/(?=^      - )/m)
  for (const command of ['pnpm build', 'pnpm exec prisma migrate deploy', 'pnpm test:integration']) {
    const step = steps.find(step => step.includes(`run: ${command}\n`))
    expect(step, command).toBeDefined()
    expect(step, command).toContain('DATABASE_URL: ${{ env.TEST_DATABASE_URL }}')
  }
})

it('CI 集成 job 自行构建，与 check job 使用相同命令，构建先于迁移和集成测试', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  const integrationStart = workflow.indexOf('\n  integration:')
  const check = workflow.slice(workflow.indexOf('\n  check:'), integrationStart)
  const job = workflow.slice(integrationStart)
  const steps = job.split(/(?=^      - )/m)
  const buildCommand = steps.find(step => step.startsWith('      - name: Build\n'))?.match(/run: ([^\n]+)/)?.[1]
  expect(buildCommand).toBe('pnpm build')
  expect(check).toContain(`run: ${buildCommand}`)

  const order = ['uses: actions/checkout@v4', 'name: Install', 'name: Build', 'name: Deploy test schema', 'name: Integration tests']
    .map(step => steps.findIndex(block => block.includes(step)))
  expect(order.every(index => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})
