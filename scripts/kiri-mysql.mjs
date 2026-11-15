import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const KIRI_MYSQL = Object.freeze({
  demo: { name: 'ft-demo-mysql', port: 13307, database: 'fulfillment_demo' },
  test: { name: 'ft-test-mysql', port: 13308, database: 'fulfillment_test' },
})
const OWNER_LABEL = 'app.fulfillment.local-mysql'
const MYSQL_IMAGE = 'mysql:8.0'
const READY_ATTEMPTS = 90
const READY_INTERVAL_MS = 1000
let clientConfig

/** The bundled CLI works even when Docker Desktop left a broken PATH symlink. */
export function dockerCommand(exists = existsSync) {
  const bundled = '/Applications/Kiri.app/Contents/Resources/bin/docker'
  return exists(bundled) ? bundled : 'docker'
}

export function kiri(args, options = {}) {
  // Public MySQL pulls need no registry credentials. Do not inherit stale Desktop credential helpers.
  if (!clientConfig) {
    clientConfig = mkdtempSync(join(tmpdir(), 'ft-kiri-client-'))
    process.once('exit', () => rmSync(clientConfig, { recursive: true, force: true }))
  }
  const env = { ...process.env, ...options.env }
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key]
  return execFileSync(dockerCommand(), ['--config', clientConfig, '--host', `unix://${homedir()}/.kiri/run/docker.sock`, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options, env,
  })
}

export function mysqlTarget(kind) {
  if (!Object.hasOwn(KIRI_MYSQL, kind)) throw new Error('Unknown local MySQL purpose')
  return KIRI_MYSQL[kind]
}

/** Inspect only identity and port metadata; never return container credentials. */
export function inspectMysql(kind) {
  const target = mysqlTarget(kind)
  const format = '{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}|{{.State.Running}}'
  const [labels, ports, running] = kiri(['inspect', '--format', format, target.name]).trim().split('|')
  const bindings = JSON.parse(ports)?.['3306/tcp'] ?? []
  if (JSON.parse(labels)?.[OWNER_LABEL] !== kind || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(target.port)) {
    throw new Error('Local MySQL identity or port mismatch')
  }
  return running === 'true'
}

/** Root credentials stay in the container; application accounts receive schema-local grants. */
export function mysqlSql(kind, input) {
  const target = mysqlTarget(kind)
  return kiri(['exec', '-i', target.name, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --skip-column-names'], { input })
}

export async function ensureMysql(kind, { checkOnly = false } = {}) {
  const target = mysqlTarget(kind)
  const names = kiri(['ps', '-a', '--format', '{{.Names}}']).trim().split('\n')
  if (!names.includes(target.name)) {
    if (checkOnly) throw new Error('Local MySQL is not prepared')
    const volume = `${target.name}-data`
    const volumes = kiri(['volume', 'ls', '--format', '{{.Name}}']).trim().split('\n')
    // An orphaned volume may contain a different root account. Never silently adopt it.
    if (volumes.includes(volume)) throw new Error('Existing MySQL volume requires explicit recovery')
    kiri(['pull', MYSQL_IMAGE])
    kiri(['volume', 'create', '--label', `${OWNER_LABEL}=${kind}`, volume])
    kiri(['run', '-d', '--name', target.name, '--label', `${OWNER_LABEL}=${kind}`,
      '--restart', 'unless-stopped', '-p', `127.0.0.1:${target.port}:3306`,
      '-v', `${volume}:/var/lib/mysql`, '-e', 'MYSQL_ROOT_PASSWORD', MYSQL_IMAGE], {
      env: { ...process.env, MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex') },
    })
  }
  if (!inspectMysql(kind)) {
    if (checkOnly) throw new Error('Local MySQL is stopped')
    kiri(['start', target.name])
  }
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try { mysqlSql(kind, 'SELECT 1;'); return target } catch {
      if (checkOnly || attempt === READY_ATTEMPTS - 1) throw new Error('Local MySQL is not ready')
      await new Promise(resolve => setTimeout(resolve, READY_INTERVAL_MS))
    }
  }
}
