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
  expect(job).toContain('DATABASE_URL: ${{ env.TEST_DATABASE_URL }}')
  expect(job).toContain('pnpm exec prisma migrate deploy')
  expect(job).toContain('pnpm test:integration')
})
