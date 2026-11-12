#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productionConfigErrors } from '../shared/production-config.mjs'
import { monitoringConfig, renderMonitoring } from './render-monitoring-config.mjs'

export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.observability.yml']
const MONITORS = ['alloy', 'loki', 'grafana', 'prometheus', 'alertmanager', 'blackbox', 'node-exporter', 'cadvisor']

export function validateDeployment(env) {
  const errors = productionConfigErrors(env)
  for (const key of ['GRAFANA_ADMIN_PASSWORD', 'ALERT_SMTP_PASSWORD']) {
    if (!env[key] || env[key].includes('CHANGE_ME')) errors.push(key)
  }
  if ((env.GRAFANA_ADMIN_PASSWORD ?? '').length < 16) errors.push('GRAFANA_ADMIN_PASSWORD')
  try { monitoringConfig(env) } catch { errors.push('ALERT_EMAIL / ALERT_SMTP configuration') }
  try {
    const health = new URL(env.ALERT_PUBLIC_HEALTH_URL)
    const callback = new URL(env.NUXT_QMS_CALLBACK_URL)
    if (health.origin !== callback.origin || health.pathname !== '/api/health' || health.search || health.hash || health.username || health.password) throw new Error()
  } catch { errors.push('ALERT_PUBLIC_HEALTH_URL') }
  if (errors.length) throw new Error(`Invalid configuration fields: ${[...new Set(errors)].join(', ')}`)
}

/** Reject proxy error pages that happen to return HTTP 200. */
export async function healthy(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    const body = await response.json()
    return response.ok && body.code === 0 && body.data?.ok === true
  } catch { return false }
}

export async function verify(env) {
  const targets = ['http://127.0.0.1:3100/api/health', env.ALERT_PUBLIC_HEALTH_URL, env.ALERT_PUBLIC_HEALTH_URL + '/monitoring']
  for (let attempt = 0; attempt < 24; attempt++) {
    if ((await Promise.all(targets.map(url => healthy(url)))).every(Boolean)) {
      console.log('PASS local database health, public HTTPS health and monitoring readiness')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  throw new Error('Health acceptance failed. Inspect app, proxy, database and monitoring; no automatic database rollback was attempted.')
}

export async function main(mode = process.argv[2], configFile = process.argv[3] ?? 'deploy/production.env') {
  if (!['check', 'deploy', 'verify'].includes(mode)) throw new Error('Usage: node scripts/production.mjs check|deploy|verify [config-file]')
  const path = resolve(configFile)
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('Production configuration must be a file with mode 0600')
  const config = parseEnv(await readFile(path, 'utf8'))
  validateDeployment(config)
  // Shell overrides must not silently change the configuration that passed validation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NUXT_|NITRO_|FT_|COMPOSE_|ALERT_|GRAFANA_|DATABASE_URL$)/.test(key)))
  Object.assign(env, config, { FT_ENV_FILE: path })
  const compose = ['compose', '--project-name', 'fulfillment', '--env-file', path, ...COMPOSE_FILES.flatMap(file => ['-f', file])]
  const run = (args, capture = false) => {
    const result = spawnSync('docker', args, { env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
    if (result.error || result.status !== 0) throw new Error(`Docker step failed: ${args.slice(0, 2).join(' ')} (exit ${result.status ?? 'unavailable'})`)
    return result.stdout?.trim() ?? ''
  }
  if (mode === 'verify') { await verify(config); return }
  if (process.platform !== 'linux') throw new Error('Production host monitoring requires a dedicated Linux Docker host; use the isolated rehearsal on macOS')
  run(['compose', 'version'])
  if (run(['info', '--format', '{{.OSType}}'], true) !== 'linux') throw new Error('Linux Docker Engine required')
  run(['network', 'inspect', 'qms-network'], true)
  run([...compose, 'config', '--quiet'])
  console.log('PASS production fields, Compose configuration, Docker and QMS network')
  if (mode === 'check') return
  await renderMonitoring(config)
  run([...compose, 'build', 'fulfillment'])
  run([...compose, 'pull', ...MONITORS])
  run([...compose, 'run', '--rm', '--no-deps', '--entrypoint', '/bin/amtool', 'alertmanager', 'check-config', '/etc/alertmanager/alertmanager.yaml'])
  run([...compose, 'run', '--rm', '--no-deps', 'fulfillment', 'node', 'scripts/check-production.mjs'])
  // Schema compatibility must be reviewed before a manual rollback to this saved image.
  const old = spawnSync('docker', ['inspect', '--format', '{{.Image}}', 'fulfillment'], { env, encoding: 'utf8' })
  if (old.status === 0) run(['tag', old.stdout.trim(), 'fulfillment-tracker:prev'])
  run([...compose, 'run', '--rm', '--no-deps', 'fulfillment', 'prisma', 'migrate', 'deploy'])
  run([...compose, 'run', '--rm', '--no-deps', 'fulfillment', 'prisma', 'migrate', 'status'])
  run([...compose, 'up', '-d'])
  await verify(config)
  console.log('Infrastructure acceptance passed. Complete real QMS login, business initialization, mail delivery and external-host acceptance before opening production.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
