/**
 * QMS 工单写接口客户端（履约新建工单，接口约定 v1 2026-10-27）。与只读同步客户端（client.ts）同一套配置和凭据头、同样 15 秒超时：
 *
 *   POST {apiBase}/api/integration/fulfillment/work-orders                       新建
 *   PUT  {apiBase}/api/integration/fulfillment/work-orders/:workOrderNumber      修改（带 version，乐观锁）
 *   POST {apiBase}/api/integration/fulfillment/work-orders/:workOrderNumber/cancel  取消（带 version；已取消再取消直接返回当前对象）
 *   GET  {apiBase}/api/integration/fulfillment/customers                         客户列表 [{ id, name }]
 *   请求头 X-Identity-Client-Id / X-Identity-Client-Secret；成功 HTTP 200 { code: 0, data }；
 *   失败 400 / 404 / 409，body 为 { code: -1, data: null, error: { code: WORK_ORDER_EXISTS | OPTIMISTIC_LOCK_CONFLICT | BAD_REQUEST | NOT_FOUND }, message }。
 *
 * 错误分两类，都是 FlowHttpError（接口层按 statusCode 返回，message 直接给用户看）：
 *   - QmsUnavailable（503）：未配置、连不上、超时、5xx、凭据被拒、响应不是约定格式 → "QMS 暂时连不上，请稍后再试"。
 *     原因（不含密钥：密钥只在请求头里）放在 detail，接口层写服务器日志。
 *   - QmsRejected：QMS 明确拒绝（400 / 404 / 409），状态码和中文 message 原样透传，code 给服务层判断（如版本冲突换成固定文案）。
 *     404 只有 body 里带了 message 或错误码才算（工单不存在）；否则多半是 QMS 还没有这个接口（没发版、网关页面），按连不上处理。
 * 写接口不看 NUXT_QMS_SYNC_ENABLED（那是后台同步任务的开关），只要地址和凭据配齐就能写。
 */
import { z } from 'zod'
import { FlowHttpError } from '../flow/errors'
import { REQUEST_TIMEOUT_MS, fetchSyncPage, type QmsSyncConfig, type SyncCursorValue, formatIssues } from './client'
import { type QmsWorkOrderRow, qmsWorkOrderSchema } from './resources'

export const QMS_UNAVAILABLE_TEXT = 'QMS 暂时连不上，请稍后再试'

export class QmsUnavailable extends FlowHttpError {
  constructor(readonly detail: string) {
    super(QMS_UNAVAILABLE_TEXT, 503, 'INTERNAL')
    this.name = 'QmsUnavailable'
  }
}

export class QmsRejected extends FlowHttpError {
  constructor(
    message: string,
    statusCode: number,
    /** QMS 的错误码，如 WORK_ORDER_EXISTS、OPTIMISTIC_LOCK_CONFLICT；没有为 null */
    override readonly code: string | null,
  ) {
    super(message, statusCode)
    this.name = 'QmsRejected'
  }
}

export interface CreateWorkOrderBody {
  workOrderNumber: string
  customerNameId: string
  projectName?: string | null
  divisionId?: string | null
  quantity: number
  /** 'YYYY-MM-DD' */
  deliveryDate: string
  actorUserId: string
}

export interface UpdateWorkOrderBody {
  version: number
  actorUserId: string
  customerNameId?: string
  projectName?: string | null
  divisionId?: string | null
  quantity?: number
  deliveryDate?: string
  status?: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED'
}

export interface QmsCustomer {
  id: string
  name: string
}

/** 服务层只依赖这个接口，单测里换成假的 */
export interface QmsWorkOrderApi {
  /** 恢复前核对远端现状；沿已有只读分页同步契约查找，不能用本地副本代替。 */
  findWorkOrder(workOrderNumber: string): Promise<QmsWorkOrderRow | null>
  createWorkOrder(body: CreateWorkOrderBody): Promise<QmsWorkOrderRow>
  updateWorkOrder(workOrderNumber: string, body: UpdateWorkOrderBody): Promise<QmsWorkOrderRow>
  cancelWorkOrder(workOrderNumber: string, body: { version: number; actorUserId: string }): Promise<QmsWorkOrderRow>
  listCustomers(): Promise<QmsCustomer[]>
}

const BASE = '/api/integration/fulfillment'

/** 地址和凭据都有才算配置好（不看同步开关） */
export const writeConfigured = (cfg: Pick<QmsSyncConfig, 'apiBase' | 'clientId' | 'clientSecret'>) => !!cfg.apiBase && !!cfg.clientId && !!cfg.clientSecret

const okBody = z.object({ code: z.literal(0), data: z.unknown() })
const customers = z.array(
  z.object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    name: z.string(),
  }),
)
/** QMS 错误 body：{ code: -1, error: { code }, message }；兼容错误码直接放在 code / errorCode / error 字符串里 */
const errBody = z
  .object({ message: z.string().optional(), code: z.unknown().optional(), error: z.unknown().optional(), errorCode: z.unknown().optional() })
  .passthrough()

export function qmsWorkOrderClient(cfg: Pick<QmsSyncConfig, 'apiBase' | 'clientId' | 'clientSecret'>, fetchImpl: typeof fetch = fetch): QmsWorkOrderApi {
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (!writeConfigured(cfg)) throw new QmsUnavailable('QMS 地址或客户端凭据未配置（NUXT_QMS_API_BASE / NUXT_QMS_CLIENT_ID / NUXT_QMS_CLIENT_SECRET）')
    const url = new URL(path, cfg.apiBase).toString()
    let res: Response
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Identity-Client-Id': cfg.clientId,
          'X-Identity-Client-Secret': cfg.clientSecret,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const e = err as Error
      const reason = e?.name === 'TimeoutError' ? `超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` : (e?.message ?? String(err))
      throw new QmsUnavailable(`${method} ${path} 无法连接：${reason}`)
    }
    const json: unknown = await res.json().catch(() => undefined)
    if (res.ok) {
      const parsed = okBody.safeParse(json)
      if (parsed.success) return parsed.data.data
      // 200 但 code ≠ 0：按业务拒绝处理（有中文 message 就透传）
      const e = errBody.safeParse(json)
      if (e.success && e.data.message) throw new QmsRejected(e.data.message, 400, errCode(e.data))
      throw new QmsUnavailable(`${method} ${path} 返回 ${res.status}，响应格式不符`)
    }
    const e = errBody.safeParse(json)
    const msg = e.success ? e.data.message : undefined
    const code = e.success ? errCode(e.data) : null
    // 404 不带 message / 错误码（如 HTML 页面）：QMS 还没有这个接口，不当成"工单不存在"
    if (res.status === 400 || res.status === 409 || (res.status === 404 && (msg || code))) {
      throw new QmsRejected(msg || DEFAULT_REJECT_TEXT[res.status]!, res.status, code)
    }
    // 401 / 403（凭据不对）、5xx、其他：用户只看到"连不上"，原因进日志
    const hint = res.status === 401 ? '（客户端凭据不对）' : res.status === 404 ? '（QMS 还没有这个接口）' : ''
    throw new QmsUnavailable(`${method} ${path} 返回 ${res.status}${hint}${msg ? `：${msg}` : ''}`)
  }

  const workOrder = (data: unknown, what: string) => {
    const r = qmsWorkOrderSchema.safeParse(data)
    // QMS 已经写成功了，只是返回的格式不对：不写本地副本，下一轮同步会补上
    if (!r.success) throw new QmsUnavailable(`${what}：QMS 返回的工单格式不符：${formatIssues(r.error)}`)
    return r.data
  }
  const enc = encodeURIComponent

  return {
    async findWorkOrder(no) {
      if (!writeConfigured(cfg)) throw new QmsUnavailable('QMS 地址或客户端凭据未配置')
      let cursor: SyncCursorValue = { since: null, afterId: null }
      for (;;) {
        const page = await fetchSyncPage({ ...cfg, enabled: true }, 'work-orders', cursor, undefined, fetchImpl).catch((error: unknown) => {
          throw new QmsUnavailable(`恢复核对：${error instanceof Error ? error.message : String(error)}`)
        })
        for (const item of page.items) {
          const row = qmsWorkOrderSchema.safeParse(item)
          if (!row.success) throw new QmsUnavailable(`恢复核对：QMS 返回的工单格式不符：${formatIssues(row.error)}`)
          if (row.data.workOrderNumber === no) return row.data
        }
        if (!page.nextCursor) return null
        if (cursor.since && (+page.nextCursor.since < +cursor.since || (+page.nextCursor.since === +cursor.since && page.nextCursor.afterId <= (cursor.afterId ?? '')))) throw new QmsUnavailable('恢复核对：QMS 分页游标没有前进')
        cursor = page.nextCursor
      }
    },
    async createWorkOrder(body) {
      return workOrder(await call('POST', `${BASE}/work-orders`, body), '新建工单')
    },
    async updateWorkOrder(no, body) {
      return workOrder(await call('PUT', `${BASE}/work-orders/${enc(no)}`, body), '修改工单')
    },
    async cancelWorkOrder(no, body) {
      return workOrder(await call('POST', `${BASE}/work-orders/${enc(no)}/cancel`, body), '取消工单')
    },
    async listCustomers() {
      const r = customers.safeParse(await call('GET', `${BASE}/customers`))
      if (!r.success) throw new QmsUnavailable(`客户列表：QMS 返回的格式不符：${formatIssues(r.error)}`)
      return r.data
    },
  }
}

const DEFAULT_REJECT_TEXT: Record<number, string> = {
  400: 'QMS 拒绝了这次操作（参数不对）',
  404: '工单在 QMS 里不存在或已删除',
  409: 'QMS 里的数据有冲突，请刷新后再试',
}

function errCode(b: { code?: unknown; error?: unknown; errorCode?: unknown }): string | null {
  const nested = b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : undefined
  for (const v of [nested, b.errorCode, b.error, b.code]) if (typeof v === 'string' && v) return v
  return null
}
