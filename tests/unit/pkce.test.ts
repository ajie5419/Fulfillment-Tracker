import { describe, expect, it } from 'vitest'
import { codeChallengeS256, createCodeVerifier } from '../../server/services/auth/pkce'

describe('PKCE', () => {
  it('RFC 7636 附录 B 的标准向量', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('code_verifier 长度和字符集合规', () => {
    const v = createCodeVerifier()
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(createCodeVerifier()).not.toBe(v)
  })
})
