/**
 * QMS 身份桥客户端（授权码 + PKCE）。
 *
 * 履约系统只通过本文件与身份桥交互；接口路径、参数名都集中在这里和 runtimeConfig.qms 中，
 * 与 QMS 身份桥代码核对后只需改这一处。
 *
 * 流程：
 *  1. buildAuthorizeUrl：浏览器跳到 QMS 授权页，带 client_id / redirect_uri / state / code_challenge
 *  2. exchangeCode：服务端用 code + code_verifier + 客户端密钥换身份凭证（走内网 qms-backend）
 *  3. verifyIdentity：用身份凭证查 {id, name, active}
 */
import { z } from 'zod'

export interface IdentityBridgeConfig {
  /** QMS 后端基地址，服务端调用用，生产为 http://qms-backend:3000 */
  apiBase: string
  /** QMS 授权页的完整地址（浏览器访问），例如 http://localhost:5666/#/auth/identity-authorize */
  authorizeUrl: string
  tokenPath: string
  verifyPath: string
  clientId: string
  clientSecret: string
  /** 必须是 https，身份桥会拒绝 http 回调 */
  callbackUrl: string
}

export interface VerifiedIdentity {
  id: string
  name: string
  active: boolean
}

export class IdentityBridgeError extends Error {
  constructor(
    message: string,
    readonly stage: 'exchange' | 'verify',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'IdentityBridgeError'
  }
}

const tokenResponse = z
  .object({
    identityToken: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
  })
  .transform((v) => v.identityToken ?? v.accessToken ?? v.access_token)
  .pipe(z.string().min(1))

const identityResponse = z.object({
  id: z.coerce.string().min(1),
  name: z.string(),
  active: z.boolean(),
})

/** 身份桥可能直接返回对象，也可能包在 QMS 通用的 { code, data } 里 */
function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body && (body as { data: unknown }).data) {
    return (body as { data: unknown }).data
  }
  return body
}

export function buildAuthorizeUrl(
  cfg: IdentityBridgeConfig,
  params: { state: string; codeChallenge: string },
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  })
  // 授权页可能是 hash 路由（.../#/auth/...），参数要拼在 hash 部分之后
  const sep = cfg.authorizeUrl.includes('?') ? '&' : '?'
  return `${cfg.authorizeUrl}${sep}${query.toString()}`
}

function clientHeaders(cfg: IdentityBridgeConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Identity-Client-Id': cfg.clientId,
    'X-Identity-Client-Secret': cfg.clientSecret,
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  stage: 'exchange' | 'verify',
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw new IdentityBridgeError(`无法连接 QMS 身份桥：${(err as Error).message}`, stage)
  }
  if (!res.ok) {
    throw new IdentityBridgeError(`QMS 身份桥返回 ${res.status}`, stage, res.status)
  }
  return res.json().catch(() => {
    throw new IdentityBridgeError('QMS 身份桥返回的不是 JSON', stage, res.status)
  })
}

export async function exchangeCode(
  cfg: IdentityBridgeConfig,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = await postJson(
    new URL(cfg.tokenPath, cfg.apiBase).toString(),
    clientHeaders(cfg),
    { grant_type: 'authorization_code', code: params.code, code_verifier: params.codeVerifier, redirect_uri: cfg.callbackUrl },
    'exchange',
    fetchImpl,
  )
  const parsed = tokenResponse.safeParse(unwrap(body))
  if (!parsed.success) throw new IdentityBridgeError('身份桥换取凭证的响应格式不符', 'exchange')
  return parsed.data
}

export async function verifyIdentity(
  cfg: IdentityBridgeConfig,
  identityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity> {
  const body = await postJson(
    new URL(cfg.verifyPath, cfg.apiBase).toString(),
    clientHeaders(cfg),
    { identityToken },
    'verify',
    fetchImpl,
  )
  const parsed = identityResponse.safeParse(unwrap(body))
  if (!parsed.success) throw new IdentityBridgeError('身份核查的响应格式不符', 'verify')
  return parsed.data
}
