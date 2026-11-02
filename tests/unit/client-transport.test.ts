import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { clientErrorMessage, clientRequest, ClientRequestError, sendClientRequest } from '../../app/utils/transport'
import { apiError } from '../../app/composables/useFlow'
import { drawingSend, fetchDrawing } from '../../app/composables/useDrawings'
import { purchaseSend, fetchPurchase } from '../../app/composables/usePurchases'
import { releasePost, fetchRelease, uploadAttachments, uploadBomFile } from '../../app/composables/useReleases'
import { kittingSend, fetchKitNode } from '../../app/composables/useKitting'
import { processAction, fetchProcessLogs } from '../../app/composables/useProcess'
import { issueAction, uploadPhotos } from '../../app/composables/useIssues'
import type { ClientResponse } from '../../app/utils/transport'

const fetch = vi.fn()
beforeEach(() => {
  fetch.mockReset()
  vi.stubGlobal('$fetch', fetch)
  vi.stubGlobal('clientRequest', clientRequest)
  vi.stubGlobal('sendClientRequest', sendClientRequest)
})
afterEach(() => vi.unstubAllGlobals())

it('成功响应原样透传，响应类型由 URL 与 method 决定', async () => {
  const result = { created: 3 }
  fetch.mockResolvedValue(result)
  const response = clientRequest('/api/plan/generate', { method: 'POST', body: { workOrderNumber: 'WO', templateId: 'tpl' } })
  expectTypeOf(response).toEqualTypeOf<Promise<ClientResponse<'/api/plan/generate', 'POST'>>>()
  expect(await response).toBe(result)
  expect(fetch).toHaveBeenCalledWith('/api/plan/generate', { method: 'POST', body: { workOrderNumber: 'WO', templateId: 'tpl' } })
})

it('SSR 使用注入的 request fetch，保留 headers、signal 和请求选项', async () => {
  const requestFetch = vi.fn().mockResolvedValue({ id: 'release' })
  const signal = new AbortController().signal
  const headers = { cookie: 'session=test', 'x-request-id': 'test' }
  await clientRequest('/api/releases/r', { headers, signal }, requestFetch)
  expect(requestFetch).toHaveBeenCalledWith('/api/releases/r', { headers, signal })
  expect(fetch).not.toHaveBeenCalled()
  await fetchRelease('a/b', requestFetch)
  expect(requestFetch).toHaveBeenLastCalledWith('/api/releases/a%2Fb', undefined)
})

it.each([
  [{ statusCode: 409, data: { message: '中文错误', statusMessage: 'Conflict', extra: 'kept' } }, '中文错误', 409],
  [{ status: 400, data: { statusMessage: '参数失败' } }, '参数失败', 400],
  [{ data: { statusCode: 503 }, message: 'offline' }, 'offline', 503],
  [null, '操作失败', undefined],
])('错误归一保留 HTTP 状态与现有文案回退：%j', async (failure, text, statusCode) => {
  fetch.mockRejectedValue(failure)
  const error = await clientRequest('/api/drawings/d').catch(error => error)
  expect(error).toBeInstanceOf(ClientRequestError)
  expect(error).toMatchObject({ message: text, statusCode, cause: failure })
  expect(error.data).toMatchObject({ message: text, statusCode })
  if (failure?.data && 'extra' in failure.data) expect(error.data.extra).toBe('kept')
  expect(apiError(error)).toBe(text)
  expect(clientErrorMessage(failure)).toBe(text)
})

it('已归一的错误和取消错误保持身份，不干扰 Nuxt 取消语义', async () => {
  const normalized = new ClientRequestError(new Error('failed'))
  fetch.mockRejectedValueOnce(normalized)
  await expect(clientRequest('/api/drawings/d')).rejects.toBe(normalized)
  const aborted = new DOMException('aborted', 'AbortError')
  fetch.mockRejectedValueOnce(aborted)
  await expect(clientRequest('/api/drawings/d')).rejects.toBe(aborted)
})

describe('领域函数经 transport 发送原来的端点与请求体', () => {
  it.each([
    ['设计详情', () => fetchDrawing('a/b'), '/api/drawings/a%2Fb', undefined],
    ['采购详情', () => fetchPurchase('a/b'), '/api/purchases/a%2Fb', undefined],
    ['齐套详情', () => fetchKitNode('a/b'), '/api/kitting/a%2Fb', undefined],
    ['工艺日志', () => fetchProcessLogs('a/b'), '/api/process/a%2Fb/logs', undefined],
    ['设计完成', () => drawingSend('/api/drawings/d/drawn', 'POST'), '/api/drawings/d/drawn', { method: 'POST', body: {} }],
    ['采购撤销', () => purchaseSend('/api/purchases/p/undo-arrival', 'POST'), '/api/purchases/p/undo-arrival', { method: 'POST', body: undefined }],
    ['签收', () => releasePost('/api/receipts/r/sign'), '/api/receipts/r/sign', { method: 'POST', body: {} }],
    ['齐套删除', () => kittingSend('/api/kitting/k', 'DELETE'), '/api/kitting/k', { method: 'DELETE', body: undefined }],
    ['工艺开始', () => processAction('a/b', { kind: 'MATERIAL', action: 'start' }), '/api/process/a%2Fb/action', { method: 'POST', body: { kind: 'MATERIAL', action: 'start' } }],
    ['异常备注', () => issueAction('a/b', 'note', { note: '备注' }), '/api/issues/a%2Fb/note', { method: 'POST', body: { note: '备注' } }],
  ] as const)('%s：响应透传与错误归一', async (_name, call, url, options) => {
    const result = { id: 'result' }
    fetch.mockResolvedValueOnce(result)
    expect(await call()).toBe(result)
    expect(fetch).toHaveBeenLastCalledWith(url, options)
    fetch.mockRejectedValueOnce({ statusCode: 404, data: { message: '不存在' } })
    await expect(call()).rejects.toMatchObject({ statusCode: 404, message: '不存在', data: { message: '不存在' } })
  })

  it('multipart 原样传入，保留附件分批上传顺序和上传 URL', async () => {
    const files = Array.from({ length: 4 }, (_, i) => new File(['test'], `${i}.pdf`))
    fetch.mockResolvedValueOnce([{ id: 'first' }]).mockResolvedValueOnce([{ id: 'second' }])
    expect(await uploadAttachments(files)).toEqual(['first', 'second'])
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/uploads?kind=attachment', '/api/uploads?kind=attachment'])
    expect(fetch.mock.calls.map(call => call[1].body.getAll('file').length)).toEqual([3, 1])
    fetch.mockResolvedValueOnce([{ id: 'bom' }])
    expect(await uploadBomFile(files[0]!)).toBe('bom')
    expect(fetch).toHaveBeenLastCalledWith('/api/uploads?kind=bom', { method: 'POST', body: expect.any(FormData) })
    fetch.mockResolvedValueOnce([{ id: 'photo' }])
    expect(await uploadPhotos(files.slice(0, 1))).toEqual(['photo'])
    expect(fetch).toHaveBeenLastCalledWith('/api/uploads', { method: 'POST', body: expect.any(FormData) })
  })
})

// These negative contract checks are compiled by Nuxt typecheck, never sent.
function checkContracts() {
  // @ts-expect-error 端点不允许 DELETE
  clientRequest('/api/plan/generate', { method: 'DELETE' })
  // @ts-expect-error 请求体缺少 templateId
  clientRequest('/api/plan/generate', { method: 'POST', body: { workOrderNumber: 'WO' } })
  // @ts-expect-error 响应类型不能由调用者指定
  drawingSend<{ fake: boolean }>('/api/drawings/d/drawn', 'POST')
  // @ts-expect-error 领域写接口也校验请求体
  purchaseSend('/api/purchases', 'POST', { wrong: true })
  // @ts-expect-error GET 也要求端点原有的必填 query
  clientRequest('/api/plan')
  // @ts-expect-error 不接受不存在的发放端点
  releasePost('/api/releases/unknown/missing')
}
void checkContracts
