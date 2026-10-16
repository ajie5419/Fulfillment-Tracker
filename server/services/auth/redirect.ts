/**
 * 登录后的回跳地址只允许站内相对路径，防止开放重定向。
 * 拒绝 "//evil.com"、"/\\evil.com"、绝对 URL 和控制字符。
 */
export function safeRedirectPath(input: unknown, fallback = '/'): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) return fallback
  if (!input.startsWith('/')) return fallback
  if (input.startsWith('//') || input.startsWith('/\\')) return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(input)) return fallback
  return input
}
