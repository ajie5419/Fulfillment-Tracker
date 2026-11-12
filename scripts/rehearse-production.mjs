#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { healthy } from './production.mjs'

// Only this script's random container names are ever removed; no existing database is reused.
const engine = process.argv.includes('--container') ? 'container' : 'docker'
const image = 'ft-production-rehearsal:local'
const prefix = `ft-rehearse-${randomBytes(5).toString('hex')}`
const names = [], volumes = []
const privateValues = []
const scratch = await mkdtemp(join(tmpdir(), prefix))
const run = (args, input) => {
  const result = spawnSync(engine, args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    let detail = result.stderr ?? ''
    for (const value of [...privateValues].sort((a, b) => b.length - a.length)) detail = detail.replaceAll(value, '[REDACTED]')
    throw new Error(`Rehearsal step failed: ${engine} ${args[0]}: ${detail.slice(-2000)}`)
  }
  return result.stdout.trim()
}
const envFile = async (name, values) => {
  privateValues.push(...Object.values(values).filter(value => value.length >= 8))
  const path = join(scratch, name)
  await writeFile(path, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
  return path
}
const start = (name, args) => {
  names.push(name)
  run(['run', '-d', '--name', name, ...args])
}
const address = name => {
  const info = JSON.parse(run(['inspect', name]))[0]
  return engine === 'container' ? info.status.networks[0].ipv4Address.split('/')[0] : Object.values(info.NetworkSettings.Networks)[0].IPAddress
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1000))
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
let failed = false
try {
  if (!process.argv.includes('--skip-build')) {
    const result = spawnSync(engine, ['build', '-t', image, '.'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('Production image build failed')
  }
  const dbName = `${prefix}-db`, qmsName = `${prefix}-qms`, appName = `${prefix}-app`, volume = `${prefix}-uploads`, databaseVolume = `${prefix}-database`
  const password = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex')
  const mysqlEnv = await envFile('mysql.env', { MYSQL_ROOT_PASSWORD: randomBytes(24).toString('hex'), MYSQL_DATABASE: 'fulfillment', MYSQL_USER: 'fulfillment', MYSQL_PASSWORD: password })
  run(['volume', 'create', databaseVolume]); volumes.push(databaseVolume)
  start(dbName, ['--memory', '2g', '--env-file', mysqlEnv, '-v', `${databaseVolume}:/var/lib/mysql`, 'mysql:8.0'])
  let ready = false
  for (let i = 0; i < 90; i++) {
    const result = spawnSync(engine, ['exec', dbName, 'sh', '-c', 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT 1"'], { stdio: 'pipe' })
    if (result.status === 0) { ready = true; break }
    await pause()
  }
  if (!ready) throw new Error('Disposable MySQL did not become ready')
  const fixture = `import {createServer} from 'node:http';createServer((q,s)=>{s.writeHead(q.url==='/api/status'?200:404,{'content-type':'application/json'});s.end(JSON.stringify({code:0,data:{ok:true}}))}).listen(3000,'0.0.0.0')`
  start(qmsName, ['node:22-alpine', 'node', '--input-type=module', '-e', fixture])
  const config = {
    FT_DEPLOYMENT_MODE: 'production', DATABASE_URL: `mysql://fulfillment:${password}@${address(dbName)}:3306/fulfillment`,
    NUXT_DEV_TOOLS: '0', NUXT_ISOLATED_DEMO: '0', NUXT_SANDBOX: '0', NUXT_QMS_SYNC_ENABLED: '1',
    NUXT_QMS_API_BASE: `http://${address(qmsName)}:3000`, NUXT_QMS_CLIENT_ID: 'fulfillment', NUXT_QMS_CLIENT_SECRET: secret,
    NUXT_QMS_AUTHORIZE_URL: 'https://identity.example.invalid/#/identity/authorize', NUXT_QMS_CALLBACK_URL: 'https://fulfillment.example.invalid/auth/callback',
    NUXT_ADMIN_USER_IDS: 'rehearsal-admin', NUXT_UPLOAD_DIR: '/app/data/uploads',
    FT_METRICS_ENABLED: '1', FT_METRICS_HOST: '127.0.0.1',
  }
  const appEnv = await envFile('app.env', config)
  run(['volume', 'create', volume]); volumes.push(volume)
  // Apple Container does not populate a new volume from the image; initialize ownership explicitly.
  run(['run', '--rm', '--user', '0', '-v', `${volume}:/app/data/uploads`, image, 'chown', '-R', '1000:1000', '/app/data/uploads'])
  const oneOff = command => run(['run', '--rm', '--env-file', appEnv, '-v', `${volume}:/app/data/uploads`, image, ...command])
  oneOff(['node', 'scripts/check-production.mjs'])
  oneOff(['prisma', 'migrate', 'deploy'])
  oneOff(['prisma', 'migrate', 'deploy'])
  oneOff(['prisma', 'migrate', 'status'])
  console.log('PASS production image dependency preflight, empty database migrations and repeat migrations')
  const invalidEnv = await envFile('invalid.env', { ...config, NUXT_DEV_TOOLS: '1' })
  const denied = spawnSync(engine, ['run', '--rm', '--env-file', invalidEnv, image, 'node', 'scripts/check-production.mjs'], { encoding: 'utf8' })
  if (denied.status === 0 || !(denied.stderr ?? '').includes('NUXT_DEV_TOOLS')) throw new Error('Production demo guard was not enforced')
  const startupDenied = spawnSync(engine, ['run', '--rm', '--env-file', invalidEnv, image], { encoding: 'utf8', timeout: 30_000 })
  if (startupDenied.error || startupDenied.status === 0 || !((startupDenied.stdout ?? '') + (startupDenied.stderr ?? '')).includes('NUXT_DEV_TOOLS')) throw new Error('Built application did not reject production demo mode')
  const appArgs = ['--env-file', appEnv, '-v', `${volume}:/app/data/uploads`, '-p', `127.0.0.1:${port}:3100`, image]
  start(appName, appArgs)
  const base = `http://127.0.0.1:${port}`
  ready = false
  for (let i = 0; i < 60; i++) { if (await healthy(base + '/api/health')) { ready = true; break } await pause() }
  if (!ready) throw new Error('Production image health did not pass')
  const protectedApi = await fetch(base + '/api/settings')
  if (protectedApi.status !== 401) throw new Error('Anonymous settings access was not blocked')
  const login = await fetch(base + '/auth/login', { redirect: 'manual' })
  if (login.status !== 302 || !login.headers.get('location')?.startsWith('https://identity.example.invalid/')) throw new Error('Production identity redirect failed')
  run(['exec', appName, 'node', '-e', "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(s=>{if(!s.includes('ft_observability_heartbeat_seconds'))process.exit(1)}).catch(()=>process.exit(1))"])
  run(['exec', appName, 'node', '-e', "require('node:fs').writeFileSync('/app/data/uploads/rehearsal-marker','persisted')"])
  // Recreate rather than mount a volume into two Apple VMs simultaneously.
  run(['stop', appName])
  run([engine === 'container' ? 'delete' : 'rm', appName])
  run(['run', '-d', '--name', appName, ...appArgs])
  run(['exec', appName, 'node', '-e', "if(require('node:fs').readFileSync('/app/data/uploads/rehearsal-marker','utf8')!=='persisted')process.exit(1)"])
  console.log('PASS production guard, built-image health, anonymous access denial, identity redirect and upload volume persistence')
  console.log('NOT VERIFIED: real QMS login/business initialization, public TLS, host metrics, external monitoring, actual email or backup restore')
} catch (error) { failed = true; console.error(error.message) }
finally {
  for (const name of names.reverse()) {
    spawnSync(engine, ['stop', name], { stdio: 'pipe' })
    const result = spawnSync(engine, [engine === 'container' ? 'delete' : 'rm', '-f', name], { stdio: 'pipe' })
    if (result.status !== 0) { failed = true; console.error(`Cleanup failed for ${name}; inspect this rehearsal resource`) }
  }
  for (const volume of volumes) {
    const result = spawnSync(engine, ['volume', engine === 'container' ? 'delete' : 'rm', volume], { stdio: 'pipe' })
    if (result.status !== 0) { failed = true; console.error(`Cleanup failed for ${volume}`) }
  }
  await rm(scratch, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
