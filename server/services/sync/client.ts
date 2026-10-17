/**
 * QMS 只读增量同步接口客户端（R2，契约 v1）。
 *
 *   GET {apiBase}/api/integration/fulfillment/<resource>?since=<ISO 带毫秒>&afterId=<key>&limit=<1–100>
 *   请求头 X-Identity-Client-Id / X-Identity-Client-Secret（与身份桥同一组凭据）
 *   响应 { code: 0, data: { items, nextCursor: { since, afterId } | null } }；按 (updatedAt, key) 升序，
 *   条件 updatedAt > since OR (updatedAt = since AND key > afterId)；本页不足 limit 时 nextCursor 为 null（已追平）。
 *   包含已软删除的行（isDeleted: true）。
 *
 * 超时、网络错误、非 2xx、响应格式不符都抛 QmsSyncError。错误信息里不带请求头（密钥只放在请求头里，不进日志）。
 */
import { z } from 'zod'

export const SYNC_RESOURCES = ['work-orders', 'suppliers', 'teams', 'processes', 'departments', 'users', 'inspections'] as const
export type SyncResource = (typeof SYNC_RESOURCES)[number]

export const RESOURCE_TEXT: Record<SyncResource, string> = {
  'work-orders': '工单',
  suppliers: '外协单位',
  teams: '厂内班组',
  processes: '工序',
  departments: '部门',
  users: '用户',
  inspections: '报检',
}

export const syncPath = (resource: SyncResource) => `/api/integration/fulfillment/${resource}`

export interface QmsSyncConfig {
  /** QMS 后端基地址（与身份桥相同），生产 http://qms-backend:3000 */
  apiBase: string
  clientId: string
  clientSecret: string
  /** NUXT_QMS_SYNC_ENABLED=0 时关闭；apiBase、clientId、clientSecret 任一为空也视为未配置 */
  enabled: boolean
}

export const syncConfigured = (cfg: QmsSyncConfig) => cfg.enabled && !!cfg.apiBase && !!cfg.clientId && !!cfg.clientSecret

export interface SyncCursorValue {
  since: Date | null
  afterId: string | null
}

export interface SyncPage {
  items: unknown[]
  nextCursor: { since: Date; afterId: string } | null
}

export class QmsSyncError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'QmsSyncError'
  }
}

const pageResponse = z.object({
  code: z.literal(0),
  data: z.object({
    items: z.array(z.unknown()),
    nextCursor: z
      .object({ since: z.string().datetime({ offset: true }), afterId: z.union([z.string(), z.number()]).transform(String) })
      .nullable(),
  }),
})

/** 单次请求超时 */
export const REQUEST_TIMEOUT_MS = 15_000

export async function fetchSyncPage(
  cfg: QmsSyncConfig,
  resource: SyncResource,
  cursor: SyncCursorValue,
  limit = 100,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncPage> {
  const url = new URL(syncPath(resource), cfg.apiBase)
  if (cursor.since) url.searchParams.set('since', cursor.since.toISOString())
  if (cursor.afterId) url.searchParams.set('afterId', cursor.afterId)
  url.searchParams.set('limit', String(limit))
  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Identity-Client-Id': cfg.clientId, 'X-Identity-Client-Secret': cfg.clientSecret },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const e = err as Error
    const reason = e?.name === 'TimeoutError' ? `超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` : (e?.message ?? String(err))
    throw new QmsSyncError(`无法连接 QMS 同步接口：${reason}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    const hint = res.status === 401 ? '（客户端凭据不对，检查 NUXT_QMS_CLIENT_ID / NUXT_QMS_CLIENT_SECRET）' : res.status === 404 ? '（QMS 还没有这个接口）' : ''
    throw new QmsSyncError(`QMS 同步接口返回 ${res.status}${hint}`, res.status)
  }
  const body = await res.json().catch(() => {
    throw new QmsSyncError('QMS 同步接口返回的不是 JSON', res.status)
  })
  const parsed = pageResponse.safeParse(body)
  if (!parsed.success) throw new QmsSyncError(`QMS 同步接口的响应格式不符：${formatIssues(parsed.error)}`)
  const next = parsed.data.data.nextCursor
  return { items: parsed.data.data.items, nextCursor: next ? { since: new Date(next.since), afterId: next.afterId } : null }
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '响应'}：${i.message}`)
    .join('；')
}
