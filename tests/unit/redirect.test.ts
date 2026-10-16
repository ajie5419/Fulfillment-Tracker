import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '../../server/services/auth/redirect'

describe('safeRedirectPath', () => {
  it.each(['/', '/m', '/m?tab=todo', '/parts/abc#x'])('站内路径 %s 原样保留', (p) => {
    expect(safeRedirectPath(p)).toBe(p)
  })

  it.each(['https://evil.com', '//evil.com', '/\\evil.com', 'm', '', '/a\nb', undefined, 123, ['/m']])(
    '非法回跳 %j 退回首页',
    (p) => {
      expect(safeRedirectPath(p)).toBe('/')
    },
  )
})
