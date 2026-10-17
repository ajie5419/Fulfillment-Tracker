/**
 * 本地模拟 QMS 只读增量同步接口（R2 契约 v1），由 mock-identity-bridge.mjs 挂在同一个端口上
 * （履约的 NUXT_QMS_API_BASE 同时用于身份桥和同步）。数据来自 JSON fixture（默认 scripts/fixtures/mock-qms.json）。
 *
 *   GET /api/integration/fulfillment/<work-orders|suppliers|processes|departments|users|inspections>?since&afterId&limit
 *   - 请求头 X-Identity-Client-Id / X-Identity-Client-Secret 不对 → 401
 *   - since 必须是 ISO 8601，limit 1–100（默认 100），否则 400
 *   - ORDER BY updatedAt, key（工单是 workOrderNumber，其余是 id）；条件 updatedAt > since OR (updatedAt = since AND key > afterId)
 *   - 含软删除的行；本页满 limit 时 nextCursor = 最后一行的 (updatedAt, key)，否则 null
 *
 * 测试和端到端脚本可以在运行时改数据（upsert 自动把 updatedAt 置为当前时间）、注入失败（failNext）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SYNC_PREFIX = '/api/integration/fulfillment/'
export const RESOURCES = ['work-orders', 'suppliers', 'processes', 'departments', 'users', 'inspections']
export const DEFAULT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-qms.json')

const keyOf = (resource) => (resource === 'work-orders' ? 'workOrderNumber' : 'id')

export function loadFixture(path = DEFAULT_FIXTURE) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return Object.fromEntries(RESOURCES.map((r) => [r, structuredClone(raw[r] ?? [])]))
}

/**
 * @param {{ clientId: string, clientSecret: string, fixture?: string | Record<string, object[]> }} options
 */
export function createMockQmsSync({ clientId, clientSecret, fixture }) {
  const data = typeof fixture === 'object' && fixture ? fixture : loadFixture(fixture)
  for (const r of RESOURCES) data[r] ??= []
  /** resource -> [{ status, remaining }]，按顺序消耗 */
  const failures = new Map()
  const stats = { requests: 0 }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /** 处理同步请求；不是同步路径时返回 false，交给身份桥 */
  function handle(req, res, url) {
    if (!url.pathname.startsWith(SYNC_PREFIX)) return false
    const resource = url.pathname.slice(SYNC_PREFIX.length)
    if (req.method !== 'GET' || !RESOURCES.includes(resource)) {
      send(res, 404, { code: -1, data: null, message: 'not found' })
      return true
    }
    stats.requests++
    if (req.headers['x-identity-client-id'] !== clientId || req.headers['x-identity-client-secret'] !== clientSecret) {
      send(res, 401, { code: -1, data: null, message: 'Identity client authentication failed' })
      return true
    }
    const injected = failures.get(resource)?.[0] ?? failures.get('*')?.[0]
    if (injected) {
      if (--injected.remaining <= 0) (failures.get(resource)?.[0] === injected ? failures.get(resource) : failures.get('*')).shift()
      send(res, injected.status, { code: -1, data: null, message: 'injected failure' })
      return true
    }
    const q = url.searchParams
    const since = q.get('since')
    const afterId = q.get('afterId') ?? ''
    const limit = q.has('limit') ? Number(q.get('limit')) : 100
    if ((since && Number.isNaN(Date.parse(since))) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      send(res, 400, { code: -1, data: null, message: 'invalid query' })
      return true
    }
    const key = keyOf(resource)
    const t = (row) => Date.parse(row.updatedAt)
    const sinceMs = since ? Date.parse(since) : null
    const rows = data[resource]
      .filter((row) => sinceMs === null || t(row) > sinceMs || (t(row) === sinceMs && String(row[key]) > afterId))
      .sort((a, b) => t(a) - t(b) || (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0))
      .slice(0, limit)
    const last = rows.at(-1)
    const nextCursor = rows.length === limit && last ? { since: new Date(t(last)).toISOString(), afterId: String(last[key]) } : null
    send(res, 200, { code: 0, data: { items: rows, nextCursor }, error: null, message: 'ok' })
    return true
  }

  return {
    handle,
    data,
    stats,
    /** 新增或修改一行（按 key 合并），updatedAt 默认为当前时间 */
    upsert(resource, row) {
      const key = keyOf(resource)
      const list = data[resource]
      const i = list.findIndex((r) => r[key] === row[key])
      const merged = { ...(i >= 0 ? list[i] : {}), ...row, updatedAt: row.updatedAt ?? new Date().toISOString() }
      if (i >= 0) list[i] = merged
      else list.push(merged)
      return merged
    },
    /** 接下来 count 次请求（resource 为 '*' 时任意资源）返回 status */
    failNext(resource, count = 1, status = 503) {
      failures.set(resource, [...(failures.get(resource) ?? []), { status, remaining: count }])
    },
    clearFailures() {
      failures.clear()
    },
  }
}
