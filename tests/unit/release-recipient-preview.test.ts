import { afterEach, expect, it, vi } from 'vitest'
const resolve = vi.hoisted(() => vi.fn().mockResolvedValue(['u1', 'u2']))
vi.mock('../../server/services/releases/recipients', () => ({ resolveRecipients: resolve }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
async function setup() {
  vi.stubGlobal('defineFlowHandler', (handler: unknown) => handler)
  vi.stubGlobal('parseBody', vi.fn().mockResolvedValue({ workOrderNumber: 'WO', type: 'DRAWING', userIds: ['u1'], groups: [] }))
  vi.stubGlobal('assertCanSee', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('assertCanOperate', vi.fn().mockResolvedValue(undefined))
  const { default: handler } = await import('../../server/api/releases/recipients-preview.post')
  return handler as unknown as (event: unknown, user: { qmsUserId: string }) => Promise<{ count: number }>
}
it('previews with the issuing permission and shared recipient resolver', async () => {
  const handler = await setup()
  expect(await handler({}, { qmsUserId: 'issuer' })).toEqual({ count: 2 })
  expect(assertCanOperate).toHaveBeenCalledWith({}, 'release', { workOrderNumber: 'WO', releaseType: 'DRAWING' })
  expect(resolve).toHaveBeenCalledWith(['u1'], [], 'issuer')
})
it('does not expand recipients outside the visible work-order scope', async () => {
  const handler = await setup()
  vi.mocked(assertCanSee).mockRejectedValueOnce(new Error('Forbidden'))
  await expect(handler({}, { qmsUserId: 'issuer' })).rejects.toThrow('Forbidden')
  expect(resolve).not.toHaveBeenCalled()
})
