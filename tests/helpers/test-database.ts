/**
 * README 与现有集成测试约定使用 fulfillment_test 专用 MySQL 库。
 * 数据库名只允许字母、数字、下划线，且 test 必须是独立的下划线分段
 * （如 fulfillment_test、fulfillment_test_1）；用户名、主机名、查询参数中的 test 不算。
 * Local runs may skip an absent URL; REQUIRE_TEST_DATABASE=1 makes absence an error.
 * Invalid configuration fails before migrations, connections, or destructive cleanup.
 */
export function getTestDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    if (process.env.REQUIRE_TEST_DATABASE === '1') throw new Error('拒绝执行集成测试：缺少 TEST_DATABASE_URL，必需的数据库测试不能跳过。')
    return undefined
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('拒绝执行集成测试：TEST_DATABASE_URL 必须是有效的 MySQL 连接串。')
  }
  if (url.protocol !== 'mysql:' || !url.hostname) {
    throw new Error('拒绝执行集成测试：TEST_DATABASE_URL 必须使用 mysql:// 并指定主机。')
  }

  const database = url.pathname.slice(1)
  if (!/^[a-z0-9_]+$/i.test(database) || !/(^|_)test(_|$)/i.test(database)) {
    throw new Error('拒绝执行集成测试：TEST_DATABASE_URL 的数据库名只能含字母、数字、下划线，且必须含独立的 test 分段（如 fulfillment_test）；测试会执行迁移和清表。')
  }
  return value
}
