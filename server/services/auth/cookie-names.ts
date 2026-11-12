/** Cookies are scoped by host, not port; the sandbox may share loopback with the existing demo. */
export function authCookieNames(sandbox: boolean) {
  return sandbox
    ? { session: 'ft_sandbox_session', loginState: 'ft_sandbox_login_state' }
    : { session: 'ft_session', loginState: 'ft_login_state' }
}

export const AUTH_COOKIES = authCookieNames(process.env.NUXT_SANDBOX === '1')
