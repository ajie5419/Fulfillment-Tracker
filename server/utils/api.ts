import type { H3Event } from 'h3'
import type { z } from 'zod'
import { FlowError } from '../services/flow/errors'

/**
 * 业务接口统一入口：要求登录 + canSee，并把服务层的业务错误（FlowError）转成 400，message 为中文。
 * 路由只做三件事：zod 校验 → 调服务 → 返回。
 */
export function defineFlowHandler<T>(handler: (event: H3Event, user: AuthUser) => Promise<T>) {
  return defineEventHandler(async (event) => {
    const user = requireUser(event)
    assertCanSee(user)
    try {
      return await handler(event, user)
    } catch (err) {
      if (err instanceof FlowError) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: err.message })
      throw err
    }
  })
}

function invalid(error: z.ZodError): never {
  const detail = error.issues.map((i) => `${i.path.join('.') || '请求'}：${i.message}`).join('；')
  throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: `参数不正确（${detail}）` })
}

export async function parseBody<S extends z.ZodTypeAny>(event: H3Event, schema: S): Promise<z.output<S>> {
  const r = schema.safeParse((await readBody(event).catch(() => undefined)) ?? {})
  return r.success ? r.data : invalid(r.error)
}

export function parseQuery<S extends z.ZodTypeAny>(event: H3Event, schema: S): z.output<S> {
  const r = schema.safeParse(getQuery(event))
  return r.success ? r.data : invalid(r.error)
}

export function routeId(event: H3Event, name = 'id'): string {
  const id = getRouterParam(event, name, { decode: true })
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '缺少 ID' })
  return id
}

/** 演示工具开关：NUXT_DEV_TOOLS=1 时开启，关闭时 /api/dev/* 一律 404 */
export function requireDevTools(event: H3Event) {
  if (!useRuntimeConfig(event).devTools) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}
