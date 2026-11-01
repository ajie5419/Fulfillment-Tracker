import { describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

describe('集成测试数据库守卫', () => {
  it.each([
    'mysql://user:password@127.0.0.1:3306/fulfillment_test',
    'mysql://user:password@localhost/fulfillment_test?connection_limit=10',
    'mysql://user:password@localhost/fulfillment_test_1',
    'mysql://user:password@localhost/test_fulfillment',
  ])('专用测试库放行且保留原连接串：%s', (url) => {
    expect(getTestDatabaseUrl(url)).toBe(url)
  })

  it.each([
    'mysql://user:password@localhost/fulfillment',
    'mysql://test_user:password@localhost/fulfillment',
    'mysql://user:password@test-host/fulfillment',
    'mysql://user:password@localhost/fulfillment?label=test',
    'mysql://user:password@localhost/fulfillment_latest',
    'mysql://user:password@localhost/fulfillment_contest',
    'mysql://user:password@localhost/fulfillment_test/other',
    'mysql://user:password@localhost/fulfillment_%74est',
    'mysql://user:password@localhost/',
  ])('非测试库或数据库名不明确时拒绝：%s', (url) => {
    expect(() => getTestDatabaseUrl(url)).toThrow(/拒绝执行集成测试.*数据库名.*test.*迁移和清表/)
  })

  it.each(['not a url', ' ', 'postgresql://user:password@localhost/fulfillment_test', 'mysql:///fulfillment_test'])('无效连接串拒绝：%s', (url) => {
    expect(() => getTestDatabaseUrl(url)).toThrow(/拒绝执行集成测试.*TEST_DATABASE_URL.*MySQL|拒绝执行集成测试.*mysql:\/\//)
  })

  it.each([undefined, ''])('缺失地址时返回 undefined，允许跳过：%s', (url) => {
    expect(getTestDatabaseUrl(url)).toBeUndefined()
  })

  it('拒绝原因不泄露连接串或密码', () => {
    const url = 'mysql://user:do-not-print-this@localhost/fulfillment'
    try {
      getTestDatabaseUrl(url)
    } catch (error) {
      expect((error as Error).message).not.toContain(url)
      expect((error as Error).message).not.toContain('do-not-print-this')
      return
    }
    expect.unreachable('必须拒绝非测试库')
  })
})
