import type { H3Event } from 'h3'
import type { z } from 'zod'
import { FlowError, FlowForbidden, FlowHttpError } from '../services/flow/errors'
import { BUSINESS_ERROR_HTTP, businessCodeForStatus, isBusinessErrorCode } from '../../shared/errors'

/**
 * 业务接口统一入口：要求登录 + canSee（先算好本请求的可见范围），并把服务层的业务错误转成中文提示：
 * 带业务码的错误按共享映射返回；无 code 时保留 FlowForbidden → 403、FlowHttpError → 自带状态码、FlowError → 400。
 * 路由只做三件事：zod 校验 → 调服务 → 返回。
 */
export function defineFlowHandler<T>(handler: (event: H3Event, user: AuthUser) => Promise<T>) {
  return defineEventHandler(async (event) => {
    const user = requireUser(event)
    await assertCanSee(event)
    return runFlow(event, user, handler)
  })
}

/** 设置页接口：仅管理员（NUXT_ADMIN_USER_IDS），其他人 403。不能只靠前端隐藏菜单 */
export function defineAdminHandler<T>(handler: (event: H3Event, user: AuthUser) => Promise<T>) {
  return defineEventHandler(async (event) => runFlow(event, requireAdmin(event), handler))
}

async function runFlow<T>(event: H3Event, user: AuthUser, handler: (event: H3Event, user: AuthUser) => Promise<T>) {
  try {
    return await handler(event, user)
  } catch (err) {
    if (!(err instanceof FlowError)) throw err
    const code = isBusinessErrorCode(err.code) ? err.code : err.code && err instanceof FlowHttpError ? businessCodeForStatus(err.statusCode) : undefined
    const data = err instanceof FlowHttpError ? err.data : undefined
    const extra = code || data ? { data: { ...data, ...(code ? { code } : {}) } } : {}
    const mapped = code ? BUSINESS_ERROR_HTTP[code] : undefined
    if (err instanceof FlowForbidden) throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: err.message, ...extra })
    if (err instanceof FlowHttpError) {
      // 带 detail 的（QMS 连不上）把原因写进服务器日志；detail 里不含密钥
      const detail = (err as { detail?: unknown }).detail
      if (detail) console.error(`[qms-write] ${String(detail)}`)
      throw createError({ statusCode: mapped?.statusCode ?? err.statusCode, message: err.message, ...extra })
    }
    throw createError({ statusCode: mapped?.statusCode ?? 400, statusMessage: mapped?.statusMessage ?? 'Bad Request', message: err.message, ...extra })
  }
}

function invalid(error: z.ZodError): never {
  const detail = error.issues.map((i) => `${i.path.join('.') || '请求'}：${i.message}`).join('；')
  throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: `参数不正确（${detail}）`, data: { code: 'VALIDATION' } })
}

export async function parseBody<S extends z.ZodTypeAny>(event: H3Event, schema: S): Promise<z.output<S>> {
  const body = await readBody(event).catch(() => {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '请求体读取或解析失败', data: { code: 'VALIDATION' } })
  })
  // H3 读取合法空体时返回 undefined；只有读取成功后才保留原有的空体默认值语义。
  const r = schema.safeParse(body ?? {})
  return r.success ? r.data : invalid(r.error)
}

export function parseQuery<S extends z.ZodTypeAny>(event: H3Event, schema: S): z.output<S> {
  const r = schema.safeParse(getQuery(event))
  return r.success ? r.data : invalid(r.error)
}

export function routeId(event: H3Event, name = 'id'): string {
  const id = getRouterParam(event, name, { decode: true })
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '缺少 ID', data: { code: 'VALIDATION' } })
  return id
}

/** 演示工具开关：NUXT_DEV_TOOLS=1 时开启，关闭时 /api/dev/* 一律 404 */
export function requireDevTools(event: H3Event) {
  if (!useRuntimeConfig(event).devTools) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}

/** 服务层用的操作人：QMS 用户 ID + 是否管理员 */
export function actorOf(event: H3Event, user: AuthUser) {
  return { userId: user.qmsUserId, isAdmin: isAdmin(event, user) }
}
