import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each([
  { FT_CONTAINER_DEMO: '0', DATABASE_URL: 'mysql://fulfillment_demo:synthetic-secret@ft-demo-mysql:3306/fulfillment_demo' },
  { FT_CONTAINER_DEMO: '1', DATABASE_URL: 'mysql://fulfillment_demo:synthetic-secret@127.0.0.1:3306/fulfillment_demo' },
  { FT_CONTAINER_DEMO: '1', DATABASE_URL: 'mysql://root:synthetic-secret@ft-demo-mysql:3306/fulfillment_demo' },
  { FT_CONTAINER_DEMO: '1', DATABASE_URL: 'mysql://fulfillment_demo:synthetic-secret@ft-demo-mysql:3306/fulfillment_test' },
])('refuses non-container or non-demo targets before connecting', (environment) => {
  const result = spawnSync(process.execPath, ['scripts/demo-runtime.mjs'], {
    env: { ...process.env, ...environment, FT_DEMO_BRIDGE_SECRET: 'a'.repeat(64) },
    encoding: 'utf8', timeout: 5000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('演示环境准备失败')
  expect(result.stderr).not.toContain('synthetic-secret')
  expect(result.stdout).not.toContain('正在准备独立演示数据库')
})
