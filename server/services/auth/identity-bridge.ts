/**
 * QMS 身份桥客户端（授权码 + PKCE）。
 *
 * 接口依据 QMS 仓库 apps/backend/modules/identity-bridge（2026-10-15 版，ARCHITECTURE.md / schema.ts / handler.ts）：
 *  1. 浏览器跳 QMS 授权页 /identity/authorize?clientId&redirectUri&state&challenge&method=S256
 *     （QMS 生产用 hash 路由，即 http://<IP>/#/identity/authorize）。用户确认后 QMS 回跳 callback?code&state
 *  2. POST /api/identity-bridge/exchange  客户端认证头 + {redirectUri, code, verifier} → {credential, expiresAt}
 *     （body 为 strict 校验，不能多带字段；授权码 60 秒有效、一次性）
 *  3. POST /api/identity-bridge/identity  客户端认证头 + Authorization: Bearer <credential> → {id, name, active}
 *     账号停用或删除时返回 401，而不是 active:false
 *  4. POST /api/identity-bridge/revoke    同上，幂等撤销凭证。履约只在登录时用一次凭证，用完即撤销
 * 成功响应统一包在 { code: 0, data } 里。
 */
import { z } from 'zod'

export const BRIDGE_PATHS = {
  exchange: '/api/identity-bridge/exchange',
  identity: '/api/identity-bridge/identity',
  revoke: '/api/identity-bridge/revoke',
} as const

export interface IdentityBridgeConfig {
  /** QMS 后端基地址，服务端调用用，生产为 http://qms-backend:3000 */
  apiBase: string
  /** QMS 授权页完整地址（浏览器访问）：本地 http://localhost:5666/identity/authorize，生产 http://<IP>/#/identity/authorize */
  authorizeUrl: string
  clientId: string
  clientSecret: string
  /** 必须是 https、无 query/hash，并与 QMS 的 QMS_IDENTITY_CALLBACK 完全一致 */
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
    readonly stage: 'exchange' | 'identity',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'IdentityBridgeError'
  }
}

const success = <T extends z.ZodTypeAny>(data: T) => z.object({ code: z.literal(0), data })

const exchangeResponse = success(z.object({ credential: z.string().regex(/^[\w-]{43}$/), expiresAt: z.string() }))

const identityResponse = success(z.object({ id: z.coerce.string().min(1), name: z.string(), active: z.boolean() }))

export function buildAuthorizeUrl(
  cfg: IdentityBridgeConfig,
  params: { state: string; codeChallenge: string; forceLogin?: boolean },
): string {
  const query = new URLSearchParams({
    clientId: cfg.clientId,
    redirectUri: cfg.callbackUrl,
    state: params.state,
    challenge: params.codeChallenge,
    method: 'S256',
  })
  // prompt=login：即使浏览器里 QMS 已登录，也让 QMS 先退出并显示登录页（退出、换人用）
  if (params.forceLogin) query.set('prompt', 'login')
  // hash 路由时参数必须拼在 # 之后，直接字符串拼接即可同时适配两种路由
  const sep = cfg.authorizeUrl.includes('?') ? '&' : '?'
  return `${cfg.authorizeUrl}${sep}${query.toString()}`
}

function clientHeaders(cfg: IdentityBridgeConfig, credential?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Identity-Client-Id': cfg.clientId,
    'X-Identity-Client-Secret': cfg.clientSecret,
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  }
}

async function post(
  cfg: IdentityBridgeConfig,
  path: string,
  init: { headers: Record<string, string>; body?: unknown },
  stage: 'exchange' | 'identity',
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(new URL(path, cfg.apiBase).toString(), {
      method: 'POST',
      headers: init.headers,
      body: JSON.stringify(init.body ?? {}),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw new IdentityBridgeError(`无法连接 QMS 身份桥：${(err as Error).message}`, stage)
  }
  if (!res.ok) throw new IdentityBridgeError(`QMS 身份桥返回 ${res.status}`, stage, res.status)
  return res.json().catch(() => {
    throw new IdentityBridgeError('QMS 身份桥返回的不是 JSON', stage, res.status)
  })
}

export async function exchangeCode(
  cfg: IdentityBridgeConfig,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = await post(
    cfg,
    BRIDGE_PATHS.exchange,
    {
      headers: clientHeaders(cfg),
      body: { redirectUri: cfg.callbackUrl, code: params.code, verifier: params.codeVerifier },
    },
    'exchange',
    fetchImpl,
  )
  const parsed = exchangeResponse.safeParse(body)
  if (!parsed.success) throw new IdentityBridgeError('身份桥换取凭证的响应格式不符', 'exchange')
  return parsed.data.data.credential
}

export async function verifyIdentity(
  cfg: IdentityBridgeConfig,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity> {
  const body = await post(cfg, BRIDGE_PATHS.identity, { headers: clientHeaders(cfg, credential) }, 'identity', fetchImpl)
  const parsed = identityResponse.safeParse(body)
  if (!parsed.success) throw new IdentityBridgeError('身份核查的响应格式不符', 'identity')
  return parsed.data.data
}

/** 尽力撤销凭证；失败不影响登录（凭证 1 小时后自然过期）。 */
export async function revokeCredential(
  cfg: IdentityBridgeConfig,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(new URL(BRIDGE_PATHS.revoke, cfg.apiBase).toString(), {
      method: 'POST',
      headers: clientHeaders(cfg, credential),
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // 忽略
  }
}
