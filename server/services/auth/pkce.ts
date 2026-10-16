import { createHash, randomBytes } from 'node:crypto'

const base64url = (buf: Buffer) => buf.toString('base64url')

/** RFC 7636：43–128 位 unreserved 字符的 code_verifier */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32))
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes))
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
