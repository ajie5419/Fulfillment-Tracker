import { describe, expect, it } from 'vitest'
import { QmsSyncError, RESOURCE_TEXT, SYNC_RESOURCES, fetchSyncPage, syncConfigured, syncPath } from '../../server/services/sync/client'
import { RESOURCES } from '../../server/services/sync/resources'
import { DEPENDS_ON } from '../../server/services/sync/sync'

const cfg = { apiBase: 'http://qms.test:3000', clientId: 'fulfillment', clientSecret: 'super-secret-value-super-secret-00', enabled: true }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('fetchSyncPage', () => {
  it('带两个客户端请求头和游标参数（毫秒精度），解析 nextCursor', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string> }
      return json({ code: 0, data: { items: [{ id: 'a' }], nextCursor: { since: '2026-10-01T00:00:00.123Z', afterId: 'a' } } })
    }
    const page = await fetchSyncPage(cfg, 'departments', { since: new Date('2026-09-30T08:00:00.007Z'), afterId: 'z9' }, 50, fake)
    const url = new URL(seen!.url)
    expect(url.pathname).toBe('/api/integration/fulfillment/departments')
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: '2026-09-30T08:00:00.007Z', afterId: 'z9', limit: '50' })
    expect(seen!.headers).toMatchObject({ 'X-Identity-Client-Id': 'fulfillment', 'X-Identity-Client-Secret': cfg.clientSecret })
    expect(page.nextCursor).toEqual({ since: new Date('2026-10-01T00:00:00.123Z'), afterId: 'a' })
  })

  it('首次（无游标）不带 since/afterId', async () => {
    let url = ''
    await fetchSyncPage(cfg, 'users', { since: null, afterId: null }, 100, async (u) => {
      url = String(u)
      return json({ code: 0, data: { items: [], nextCursor: null } })
    })
    expect(new URL(url).search).toBe('?limit=100')
  })

  it('非 2xx、网络错误、格式不符都抛 QmsSyncError，错误信息里没有密钥', async () => {
    const errors: string[] = []
    for (const fake of [
      async () => json({ message: 'no' }, 401),
      async () => json({ message: 'down' }, 503),
      async () => {
        throw new TypeError('fetch failed')
      },
      async () => json({ code: 0, data: { items: 'x' } }),
      async () => new Response('<html>', { status: 200 }),
    ] as (typeof fetch)[]) {
      const err = await fetchSyncPage(cfg, 'suppliers', { since: null, afterId: null }, 100, fake).catch((e) => e)
      expect(err).toBeInstanceOf(QmsSyncError)
      errors.push(err.message)
    }
    expect(errors[0]).toContain('401')
    expect(errors[1]).toContain('503')
    expect(errors[2]).toContain('无法连接')
    for (const m of errors) expect(m).not.toContain(cfg.clientSecret)
  })

  it('未配置：关闭开关或地址、凭据为空', () => {
    expect(syncConfigured(cfg)).toBe(true)
    expect(syncConfigured({ ...cfg, enabled: false })).toBe(false)
    expect(syncConfigured({ ...cfg, apiBase: '' })).toBe(false)
    expect(syncConfigured({ ...cfg, clientSecret: '' })).toBe(false)
  })
})

describe('资源清单', () => {
  it('厂内班组 teams 紧跟 suppliers，报检依赖它', () => {
    expect(SYNC_RESOURCES).toEqual(['work-orders', 'suppliers', 'teams', 'processes', 'departments', 'users', 'inspections'])
    expect(RESOURCE_TEXT.teams).toBe('厂内班组')
    expect(syncPath('teams')).toBe('/api/integration/fulfillment/teams')
    expect(DEPENDS_ON.inspections).toContain('teams')
  })
})

describe('资源字段校验', () => {
  it('用户：部门 ID、isActive；报检：多工单、班组、可空字段', () => {
    const u = RESOURCES.users.schema.parse({ id: 'u1', username: 'a', realName: null, departmentId: 'd1', isActive: false, isDeleted: false, updatedAt: '2026-10-01T00:00:00.000Z' })
    expect(u).toMatchObject({ departmentId: 'd1', isActive: false, updatedAt: new Date('2026-10-01T00:00:00.000Z') })
    const i = RESOURCES.inspections.schema.parse({
      id: 'i1', requestNo: 'R1', workOrderNumber: 'W1', workOrderNumbers: ['W1', 'W2'], partName: '件', processName: '组焊', teamId: 't1',
      quantity: 2, status: 'INSPECTING', inspectionResult: 'FAIL', submittedAt: '2026-10-01T00:00:00Z', isDeleted: false, updatedAt: '2026-10-01T00:00:00Z',
    })
    expect(i).toMatchObject({ workOrderNumbers: ['W1', 'W2'], teamId: 't1', supplierId: null, linkedIssueNo: null, closedAt: null, unqualifiedQuantity: null })
    expect(RESOURCES.suppliers.schema.parse({ id: 's', name: 'n', kind: 'TEAM', isDeleted: false, updatedAt: '2026-10-01T00:00:00Z' })).toMatchObject({ kind: 'TEAM' })
    expect(RESOURCES.suppliers.schema.parse({ id: 's', name: 'n', isDeleted: false, updatedAt: '2026-10-01T00:00:00Z' })).toMatchObject({ kind: 'SUPPLIER' })
    expect(RESOURCES.suppliers.schema.parse({ id: 's', name: 'n', kind: 'SUPPLIER', isDeleted: false, updatedAt: '2026-10-01T00:00:00Z' })).toMatchObject({ kind: 'SUPPLIER' })
    // 厂内班组（teams 接口）
    expect(RESOURCES.teams.schema.parse({ id: 't1', name: '组焊一班', status: 'INACTIVE', isDeleted: true, updatedAt: '2026-10-01T00:00:00Z' })).toEqual({
      id: 't1', name: '组焊一班', status: 'INACTIVE', isDeleted: true, updatedAt: new Date('2026-10-01T00:00:00Z'),
    })
    expect(RESOURCES.teams.schema.safeParse({ id: 't1', name: '组焊一班', status: 'Qualified', updatedAt: '2026-10-01T00:00:00Z' }).success).toBe(false)
    expect(RESOURCES.teams.key(RESOURCES.teams.schema.parse({ id: 7, name: 'x', status: 'ACTIVE', updatedAt: '2026-10-01T00:00:00Z' }) as never)).toBe('7')
    expect(RESOURCES.users.schema.safeParse({ id: 'u1', username: 'a', isActive: true, updatedAt: 'not a date' }).success).toBe(false)
  })
})
