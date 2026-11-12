import { expect } from 'vitest'

/** HTTP tests assert the envelope before checking the original business payload. */
export async function readApiBody(response: Response) {
  const body = await response.json()
  expect(Object.keys(body).sort()).toEqual(['code', 'data', 'message'])
  if (response.ok) {
    expect(body.code).toBe(0)
    expect(body.message).toBe('ok')
    return body.data
  }
  expect(typeof body.code).toBe('string')
  expect(typeof body.message).toBe('string')
  return body
}
