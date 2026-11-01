import type { IncomingMessage } from 'node:http'
import { ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { source } from '../../server/schemas/flow'
import { defineFlowHandler, parseBody, parseQuery, routeId } from '../../server/utils/api'
import { FlowError, FlowForbidden, FlowHttpError } from '../../server/services/flow/errors'
import { QmsRejected, QmsUnavailable } from '../../server/services/sync/write-client'
import { clientErrorCode, clientErrorMessage, ClientRequestError } from '../../app/utils/transport'

// H3 是 Nuxt 的依赖：使用项目实际安装的解析器，不连接 HTTP 服务或数据库。
const require = createRequire(import.meta.url)
const { createError, createEvent, readBody } = createRequire(require.resolve('nuxt/package.json'))('h3') as typeof import('h3')
const schema = z.object({ source }).strict()

function bodyEvent(body?: string, contentType = 'application/json') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as IncomingMessage
  req.method = 'POST'
  req.headers = { 'content-type': contentType }
  if (body !== undefined) req.headers['content-length'] = String(Buffer.byteLength(body))
  return createEvent(req, new ServerResponse(req))
}

beforeEach(() => {
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('createError', createError)
})

describe('业务错误映射与兼容', () => {
  async function mapped(error: unknown) {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('requireUser', () => ({ qmsUserId: 'test' }))
    vi.stubGlobal('assertCanSee', async () => {})
    const handler = defineFlowHandler(async () => { throw error })
    return handler(bodyEvent()).catch(error => error)
  }

  it.each([
    ['NOT_FOUND', 404, 'Not Found'],
    ['VALIDATION', 400, 'Bad Request'],
    ['CONFLICT', 409, 'Conflict'],
  ] as const)('%s → HTTP %s + data.code，message 与 statusMessage 仍然存在', async (code, statusCode, statusMessage) => {
    const error = await mapped(new FlowError('中文业务提示', code))
    expect(error).toMatchObject({ statusCode, statusMessage, message: '中文业务提示', data: { code } })
    // 使用实际 H3 序列化形状，验证 ofetch 的 error.data.data.code 和旧文案逻辑。
    const response = error.toJSON()
    expect(response).toMatchObject({ statusCode, statusMessage, message: '中文业务提示', data: { code } })
    const client = new ClientRequestError({ data: response })
    expect(client).toMatchObject({ code, statusCode, message: '中文业务提示' })
    expect(clientErrorCode({ data: response })).toBe(code)
    expect(clientErrorMessage({ data: response })).toBe('中文业务提示')
  })

  it.each([
    [new FlowError('旧领域错误'), 400, 'Bad Request'],
    [new FlowForbidden('无权操作'), 403, 'Forbidden'],
    [new FlowHttpError('旧透传错误', 422), 422, undefined],
  ] as const)('无 code 的旧错误保留 HTTP、文案和响应形状', async (failure, statusCode, statusMessage) => {
    const error = await mapped(failure)
    expect(error.statusCode).toBe(statusCode)
    expect(error.message).toBe(failure.message)
    if (statusMessage) expect(error.statusMessage).toBe(statusMessage)
    expect(error.data).toBeUndefined()
    expect(clientErrorCode({ data: error.toJSON() })).toBeUndefined()
  })

  it('没有领域错误类型的旧异常保持原来的抛出行为', async () => {
    const error = new Error('unexpected')
    expect(await mapped(error)).toBe(error)
  })

  it('显式业务码优先于 FlowHttpError 的旧状态值，INTERNAL 保留原状态', async () => {
    expect(await mapped(new FlowHttpError('已删除', 400, 'NOT_FOUND'))).toMatchObject({ statusCode: 404, data: { code: 'NOT_FOUND' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await mapped(new QmsUnavailable('offline'))).toMatchObject({ statusCode: 503, data: { code: 'INTERNAL' } })
  })

  it('QMS 外部 code 留给服务层判断，API 对外返回最小业务码', async () => {
    const failure = new QmsRejected('数据已修改', 409, 'OPTIMISTIC_LOCK_CONFLICT')
    expect(await mapped(failure)).toMatchObject({ statusCode: 409, message: '数据已修改', data: { code: 'CONFLICT' } })
    expect(failure.code).toBe('OPTIMISTIC_LOCK_CONFLICT')
  })

  it('schema 校验、畸形 body 与缺少路径参数都返回 VALIDATION', async () => {
    await expect(parseBody(bodyEvent('{'), schema)).rejects.toMatchObject({ statusCode: 400, data: { code: 'VALIDATION' } })
    await expect(parseBody(bodyEvent('{"source":"bad"}'), schema)).rejects.toMatchObject({ statusCode: 400, data: { code: 'VALIDATION' } })
    vi.stubGlobal('getQuery', () => ({ source: 'bad' }))
    expect(() => parseQuery(bodyEvent(), schema)).toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'VALIDATION' } }))
    vi.stubGlobal('getRouterParam', () => undefined)
    expect(() => routeId(bodyEvent())).toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'VALIDATION' } }))
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseBody', () => {
  it.each(['{"source":', '{', 'not json'])('畸形 JSON 返回 400，不进入 schema 默认值：%s', async (body) => {
    const validate = vi.spyOn(schema, 'safeParse')
    await expect(parseBody(bodyEvent(body), schema)).rejects.toMatchObject({
      statusCode: 400, statusMessage: 'Bad Request', message: '请求体读取或解析失败',
    })
    expect(validate).not.toHaveBeenCalled()
  })

  it('请求体流读取失败返回 400，不进入 schema 默认值', async () => {
    const event = bodyEvent('unread')
    const req = event.node.req
    req._read = () => req.destroy(new Error('stream failed'))
    const validate = vi.spyOn(schema, 'safeParse')
    await expect(parseBody(event, schema)).rejects.toMatchObject({
      statusCode: 400, statusMessage: 'Bad Request', message: '请求体读取或解析失败',
    })
    expect(validate).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '{}'])('合法空体 / 空对象保留 source 默认 PC：%s', async (body) => {
    await expect(parseBody(bodyEvent(body), schema)).resolves.toEqual({ source: 'PC' })
  })

  it('合法 JSON 保留显式传值', async () => {
    await expect(parseBody(bodyEvent('{"source":"MOBILE"}'), schema)).resolves.toEqual({ source: 'MOBILE' })
  })

  it('合法表单请求仍按原方式解析', async () => {
    await expect(parseBody(bodyEvent('source=MOBILE', 'application/x-www-form-urlencoded'), schema)).resolves.toEqual({ source: 'MOBILE' })
  })

  it('读取成功但不满足 schema 时仍返回原有参数错误', async () => {
    await expect(parseBody(bodyEvent('{"source":"invalid"}'), schema)).rejects.toMatchObject({
      statusCode: 400, statusMessage: 'Bad Request', message: expect.stringContaining('参数不正确（source：'),
    })
  })
})
