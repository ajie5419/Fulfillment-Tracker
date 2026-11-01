import type { IncomingMessage } from 'node:http'
import { ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { source } from '../../server/schemas/flow'
import { parseBody } from '../../server/utils/api'

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
