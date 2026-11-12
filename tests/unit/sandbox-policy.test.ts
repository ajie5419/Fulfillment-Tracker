import { describe, expect, it, vi } from 'vitest'
import {
  SandboxGuardError, validateSandboxConfig, assertSandboxIdentity, sandboxMigrationState, assertSandboxCurrent, migrateSandbox,
} from '../../scripts/sandbox-policy.mjs'

const target = { database: 'fulfillment_sandbox_123456', username: 'ft_sb_123456' }
const host = '127.0.0.1'
const config = () => ({
  DATABASE_URL: 'mysql://ft_sb_123456:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456',
  SANDBOX_DATABASE: target.database, SANDBOX_HOST: host,
  NUXT_QMS_API_BASE: 'http://127.0.0.1:4110',
  NUXT_QMS_AUTHORIZE_URL: `https://${host}:3110/auth/sandbox-authorize`,
  NUXT_QMS_CALLBACK_URL: `https://${host}:3110/auth/callback`,
  NUXT_SANDBOX: '1', NUXT_QMS_SYNC_ENABLED: '0', NUXT_DEV_TOOLS: '0',
})

describe('sandbox database and migration boundary', () => {
  it('accepts only the matching dedicated database/account and actual connection identity', () => {
    expect(validateSandboxConfig(config(), host)).toEqual(target)
    expect(() => assertSandboxIdentity(target, { db: target.database, account: `${target.username}@%` })).not.toThrow()
  })

  it.each([
    'mysql://ft_sb_999:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456',
    'mysql://ft_sb_123456%27:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456',
    'mysql://ft_sb_123456:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456%60',
    'mysql://ft_sb_123456:synthetic-password@localhost:3307/fulfillment_sandbox_123456',
    'mysql://ft_sb_123456:synthetic-password@127.0.0.1:3306/fulfillment_sandbox_123456',
    'mysql://ft_sb_123456:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456?schema=other',
    'mysql://ft_sb_123456:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456#other',
    'postgres://ft_sb_123456:synthetic-password@127.0.0.1:3307/fulfillment_sandbox_123456',
    'mysql://root:synthetic-password@127.0.0.1:3307/fulfillment',
    'mysql://ft_sb_123456@127.0.0.1:3307/fulfillment_sandbox_123456',
    'not-a-url',
  ])('rejects unsafe or mismatched URL without echoing it: %s', (url) => {
    let caught: unknown
    try { validateSandboxConfig({ ...config(), DATABASE_URL: url }, host) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(SandboxGuardError)
    expect(String(caught)).not.toContain('synthetic-password')
  })

  it.each([
    { SANDBOX_DATABASE: 'fulfillment_sandbox_999' }, { SANDBOX_HOST: '192.168.1.1' },
    { NUXT_QMS_API_BASE: 'https://production.example' }, { NUXT_QMS_AUTHORIZE_URL: 'https://production.example' },
    { NUXT_QMS_CALLBACK_URL: 'https://production.example' }, { NUXT_SANDBOX: '0' },
    { NUXT_QMS_SYNC_ENABLED: '1' }, { NUXT_DEV_TOOLS: '1' },
  ])('rejects inconsistent isolation settings: %j', (overrides) => {
    expect(() => validateSandboxConfig({ ...config(), ...overrides }, host)).toThrow(SandboxGuardError)
  })

  it.each([
    { db: 'fulfillment', account: 'ft_sb_123456@%' },
    { db: target.database, account: 'root@localhost' },
    { db: target.database, account: 'ft_sb_999@%' },
    { db: target.database, account: 'ft_sb_123456@localhost' },
  ])('rejects an unexpected connected database/account: %j', (identity) => {
    expect(() => assertSandboxIdentity(target, identity)).toThrow(SandboxGuardError)
  })

  const applied = (name: string) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null })
  it('blocks start with an actionable upgrade instruction until pending migrations are applied', () => {
    const pending = sandboxMigrationState(['001', '002'], [applied('001')])
    expect(pending).toEqual(['002'])
    expect(() => assertSandboxCurrent(pending)).toThrow('node scripts/sandbox.mjs upgrade')
    expect(() => assertSandboxCurrent(sandboxMigrationState(['001', '002'], [applied('001'), applied('002')]))).not.toThrow()
  })
  it('does not treat a rolled-back attempt as applied, but accepts its later successful retry', () => {
    const rolledBack = { migration_name: '001', finished_at: null, rolled_back_at: new Date() }
    expect(sandboxMigrationState(['001'], [rolledBack])).toEqual(['001'])
    expect(sandboxMigrationState(['001'], [rolledBack, applied('001')])).toEqual([])
  })
  it('blocks failed and unknown migration histories instead of resetting them', () => {
    expect(() => sandboxMigrationState(['001'], [{ migration_name: '001', finished_at: null, rolled_back_at: null }])).toThrow('未完成的迁移')
    expect(() => sandboxMigrationState(['001'], [applied('002')])).toThrow('禁止降级启动')
  })
})

describe('sandbox temporary migration privileges', () => {
  const grant = "GRANT CREATE,ALTER,INDEX,REFERENCES ON `fulfillment_sandbox_123456`.* TO 'ft_sb_123456'@'%';"
  const revoke = "REVOKE CREATE,ALTER,INDEX,REFERENCES ON `fulfillment_sandbox_123456`.* FROM 'ft_sb_123456'@'%';"
  it('grants only the dedicated schema DDL, performs one migration, and then revokes DDL', async () => {
    const calls: string[] = []
    await migrateSandbox({ target, executeSql: async (sql: string) => { calls.push(sql) }, migrate: async () => { calls.push('migrate deploy') } })
    expect(calls).toEqual([grant, 'migrate deploy', revoke])
  })
  it('revokes DDL after a failed migration and preserves its error for the sanitized caller', async () => {
    const executeSql = vi.fn()
    const failure = new Error('synthetic migrate failure')
    await expect(migrateSandbox({ target, executeSql, migrate: async () => { throw failure } })).rejects.toBe(failure)
    expect(executeSql.mock.calls).toEqual([[grant], [revoke]])
  })
  it('attempts revocation even when granting privileges fails; does not run migrations', async () => {
    const failure = new Error('grant failure')
    const executeSql = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const migrate = vi.fn()
    await expect(migrateSandbox({ target, executeSql, migrate })).rejects.toBe(failure)
    expect(executeSql.mock.calls).toEqual([[grant], [revoke]])
    expect(migrate).not.toHaveBeenCalled()
  })
  it('reports a revocation failure without leaking driver credentials', async () => {
    const executeSql = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('synthetic-password'))
    await expect(migrateSandbox({ target, executeSql, migrate: vi.fn() })).rejects.toThrow('撤销沙盒临时迁移权限失败')
  })
  it.each([
    { database: 'fulfillment', username: 'root' },
    { database: 'fulfillment_sandbox_123456`.*; DROP DATABASE fulfillment; --', username: 'ft_sb_123456' },
    { database: target.database, username: "ft_sb_123456'@'%'; --" },
    { database: target.database, username: 'ft_sb_999' },
  ])('refuses unsafe targets before executing any SQL: %j', async (unsafe) => {
    const executeSql = vi.fn()
    const migrate = vi.fn()
    await expect(migrateSandbox({ target: unsafe, executeSql, migrate })).rejects.toThrow(SandboxGuardError)
    expect(executeSql).not.toHaveBeenCalled()
    expect(migrate).not.toHaveBeenCalled()
  })
})
