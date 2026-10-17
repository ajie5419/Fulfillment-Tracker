/**
 * QMS 项目 BOM 按需读取（R8）。不是增量同步：BOM 行在 QMS 里是硬删除，工序子表变化也不刷新父行时间，
 * 所以每次用户点"从 QMS BOM 导入"时实时读一次。只在服务端调用（凭据不出服务器）。
 *
 *   GET {apiBase}/api/integration/fulfillment/work-orders/<工单号>/bom
 *   请求头 X-Identity-Client-Id / X-Identity-Client-Secret（与同步、身份桥同一组凭据）
 *   响应 { code: 0, data: { workOrderNumber, items: [{ id, partId, partName, partNumber, material, quantity, unit, remarks,
 *          processes: [{ position, processId, processName }] }] } }；未知工单 items 为空
 */
import { z } from 'zod'
import { formatIssues, QmsSyncError, REQUEST_TIMEOUT_MS, type QmsSyncConfig } from '../sync/client'

export const bomPath = (workOrderNumber: string) => `/api/integration/fulfillment/work-orders/${encodeURIComponent(workOrderNumber)}/bom`

const str = z.string()
const bomItem = z.object({
  id: z.union([str, z.number()]).transform(String),
  partId: str.nullish().transform((v) => v || null),
  partName: str,
  partNumber: str.nullish().transform((v) => v || null),
  material: str.nullish().transform((v) => v || null),
  quantity: z.number().int().nullish().transform((v) => v ?? 1),
  unit: str.nullish().transform((v) => v || null),
  remarks: str.nullish().transform((v) => v || null),
  processes: z
    .array(z.object({ processId: str.nullish().transform((v) => v || null), processName: str.nullish().transform((v) => v || '') }))
    .default([]),
})
export type QmsBomItem = z.output<typeof bomItem>

const bomResponse = z.object({ code: z.literal(0), data: z.object({ items: z.array(bomItem) }) })

/** BOM 读取复用同步的地址和凭据，但不看 NUXT_QMS_SYNC_ENABLED（关掉定时同步时仍能手工导入） */
export const bomConfigured = (cfg: QmsSyncConfig) => !!cfg.apiBase && !!cfg.clientId && !!cfg.clientSecret

export async function fetchWorkOrderBom(cfg: QmsSyncConfig, workOrderNumber: string, fetchImpl: typeof fetch = fetch): Promise<QmsBomItem[]> {
  if (!bomConfigured(cfg)) throw new QmsSyncError('没有配置 QMS 接口地址或客户端凭据（NUXT_QMS_API_BASE / NUXT_QMS_CLIENT_ID / NUXT_QMS_CLIENT_SECRET）')
  const url = new URL(bomPath(workOrderNumber), cfg.apiBase)
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
    throw new QmsSyncError(`无法连接 QMS BOM 接口：${reason}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    const hint = res.status === 401 ? '（客户端凭据不对）' : res.status === 404 ? '（QMS 还没有 BOM 接口，需先升级 QMS）' : ''
    throw new QmsSyncError(`QMS BOM 接口返回 ${res.status}${hint}`, res.status)
  }
  const body = await res.json().catch(() => {
    throw new QmsSyncError('QMS BOM 接口返回的不是 JSON', res.status)
  })
  const parsed = bomResponse.safeParse(body)
  if (!parsed.success) throw new QmsSyncError(`QMS BOM 接口的响应格式不符：${formatIssues(parsed.error)}`)
  return parsed.data.data.items
}
