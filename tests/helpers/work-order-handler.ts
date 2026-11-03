/** 直接调用真实 H3 handler 和错误映射；仅替换 Nuxt 自动导入的鉴权上下文与 QMS。 */
import type { IncomingMessage } from 'node:http'
import { ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { vi } from 'vitest'
import type { RoleContext } from '../../server/services/auth/permissions'
import type { QmsWorkOrderApi } from '../../server/services/sync/write-client'
import { defineAdminHandler, defineFlowHandler, parseBody, routeId } from '../../server/utils/api'

const require = createRequire(import.meta.url)
const h3 = createRequire(require.resolve('nuxt/package.json'))('h3') as typeof import('h3')

export function stubWorkOrderHandlerGlobals(ctx: RoleContext, qms: QmsWorkOrderApi) {
  for (const name of ['defineEventHandler', 'createError', 'readBody', 'getRouterParam', 'setResponseStatus'] as const) vi.stubGlobal(name, h3[name])
  vi.stubGlobal('defineFlowHandler', defineFlowHandler)
  vi.stubGlobal('defineAdminHandler', defineAdminHandler)
  vi.stubGlobal('parseBody', parseBody)
  vi.stubGlobal('routeId', routeId)
  vi.stubGlobal('requireUser', () => ({ qmsUserId: ctx.userId }))
  vi.stubGlobal('requireAdmin', () => ({ qmsUserId: ctx.userId }))
  vi.stubGlobal('assertCanSee', async () => {})
  vi.stubGlobal('getRoleContext', async () => ctx)
  vi.stubGlobal('qmsWorkOrderApi', () => qms)
}

export async function callWorkOrderHandler(kind: 'create' | 'update' | 'retry', body?: object, id = 'WO') {
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const req = Readable.from(serialized === undefined ? [] : [Buffer.from(serialized)]) as IncomingMessage
  req.method = kind === 'update' ? 'PUT' : 'POST'
  req.headers = { 'content-type': 'application/json' }
  if (serialized !== undefined) req.headers['content-length'] = String(Buffer.byteLength(serialized))
  const event = h3.createEvent(req, new ServerResponse(req))
  event.context.params = kind === 'update' ? { no: id } : { id }
  const handler = kind === 'create' ? (await import('../../server/api/work-orders/index.post')).default
    : kind === 'update' ? (await import('../../server/api/work-orders/[no]/index.put')).default
      : (await import('../../server/api/settings/work-order-saves/[id]/retry.post')).default
  try {
    const result = await handler(event)
    return { statusCode: event.node.res.statusCode, body: result }
  } catch (error) {
    if (!h3.isError(error)) throw error
    return { statusCode: error.statusCode, body: error.toJSON() }
  }
}
