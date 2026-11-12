import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** JSON is a YAML subset, avoiding shell interpolation of SMTP credentials. */
export function monitoringConfig(env) {
  const required = name => {
    const value = env[name]
    if (!value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${name}`)
    return value
  }
  const from = required('ALERT_EMAIL_FROM'), to = required('ALERT_EMAIL_TO')
  const server = required('ALERT_SMTP_ADDRESS')
  if (!/^[a-zA-Z0-9.-]+:\d+$/.test(server)) throw new Error('ALERT_SMTP_ADDRESS must be host:port')
  if (!/^[^\s@]+@[^\s@]+$/.test(from) || !to.split(',').every(x => /^[^\s@]+@[^\s@]+$/.test(x.trim()))) throw new Error('Invalid email address')
  return {
    global: { resolve_timeout: '5m', smtp_smarthost: server, smtp_from: from, smtp_auth_username: required('ALERT_SMTP_USERNAME'), smtp_auth_password_file: '/etc/alertmanager/smtp-password', smtp_require_tls: true },
    route: { receiver: 'email', group_by: ['alertname', 'instance'], group_wait: '30s', group_interval: '5m', repeat_interval: '4h' },
    receivers: [{ name: 'email', email_configs: [{ to, send_resolved: true }] }],
  }
}

export async function renderMonitoring(env = process.env, output = resolve('deploy/observability/generated')) {
  const config = monitoringConfig(env)
  const endpoint = new URL(env.ALERT_PUBLIC_HEALTH_URL ?? '')
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/api/health')) throw new Error('ALERT_PUBLIC_HEALTH_URL must be an HTTPS /api/health URL without credentials or query')
  if (!env.ALERT_SMTP_PASSWORD) throw new Error('Missing ALERT_SMTP_PASSWORD')
  await mkdir(output, { recursive: true, mode: 0o700 })
  await chmod(output, 0o700)
  await writeFile(resolve(output, 'smtp-password'), env.ALERT_SMTP_PASSWORD, { mode: 0o600 })
  await writeFile(resolve(output, 'alertmanager.yaml'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(resolve(output, 'smtp-password'), 0o600)
  await chmod(resolve(output, 'alertmanager.yaml'), 0o600)
  await writeFile(resolve(output, 'external-targets.json'), JSON.stringify([{ targets: [endpoint.href, endpoint.href + '/monitoring'] }]) + '\n', { mode: 0o644 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await renderMonitoring()
  console.log('Monitoring mail configuration generated; credentials were not printed.')
}
