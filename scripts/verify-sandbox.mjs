import assert from 'node:assert/strict'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

process.chdir(resolve(import.meta.dirname, '..'))
const env = Object.fromEntries(readFileSync('.env.sandbox', 'utf8').trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)] }))
const base = new URL(env.NUXT_QMS_CALLBACK_URL).origin
const target = new URL(env.DATABASE_URL)
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, '3307')
assert.match(target.pathname, /^\/fulfillment_sandbox_\d+$/)
assert.equal(target.pathname.slice(1), env.SANDBOX_DATABASE)
const ca = readFileSync('certs/sandbox.pem')
const cookies = new Map()
function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const url = new URL(path, base)
  assert.equal(url.origin, base)
  return new Promise((accept, reject) => {
    const headers = { 'Content-Type': 'application/json', Origin: base }
    if (authenticated) headers.Cookie = [...cookies].filter(([name]) => name !== 'ft_login_state' || url.pathname.startsWith('/auth/')).map(([name, value]) => `${name}=${value}`).join('; ')
    const req = https.request(url, { method, ca, headers }, res => {
      for (const entry of res.headers['set-cookie'] ?? []) {
        assert(!/;\s*Domain=/i.test(entry), 'Cookie must be host-only')
        const pair = entry.split(';')[0]
        const split = pair.indexOf('=')
        if (pair.slice(split + 1)) assert(/;\s*Secure/i.test(entry), 'Cookie must be secure')
        cookies.set(pair.slice(0, split), pair.slice(split + 1))
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => accept({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}
function payload(response) { assert.equal(response.status, 200); const json = JSON.parse(response.text); return json.data ?? json }
try {
  assert.equal((await request('/api/me', { authenticated: false })).status, 401)
  const login = await request('/auth/login?redirect=/')
  assert.equal(login.status, 302)
  const authorize = new URL(login.headers.location)
  assert.equal(authorize.origin, base)
  assert.equal(authorize.pathname, '/auth/sandbox-authorize')
  const chooser = await request(authorize)
  assert.equal(chooser.status, 200)
  assert(chooser.text.includes('sandbox-pm'))
  authorize.searchParams.set('as', 'sandbox-pm')
  const consent = await request(authorize)
  assert.equal(consent.status, 302)
  const callback = new URL(consent.headers.location)
  assert.equal(callback.origin, base)
  assert.equal((await request(callback, { authenticated: false })).status, 400)
  const accepted = await request(callback)
  assert.equal(accepted.status, 302)
  assert(cookies.get('ft_session'))
  assert.equal((await request(callback)).status, 400)
  console.log('PASS: real login, PKCE exchange, CSRF rejection, one-time callback, secure host-only cookies')
  const me = payload(await request('/api/me'))
  assert.equal(me.id, 'sandbox-pm')
  assert.equal(me.devTools, false)
  console.log('PASS: authenticated /api/me identity matches sandbox; dev tools disabled')
  const orders = payload(await request('/api/work-orders?closed=1'))
  assert.equal(orders.length, 1)
  assert.equal(orders[0].workOrderNumber, 'SANDBOX-ONLY-001')
  const board = payload(await request('/api/board?closed=1'))
  assert.equal(board.rows.length, 1)
  assert.equal(board.rows[0].workOrderNumber, 'SANDBOX-ONLY-001')
  payload(await request('/api/todos'))
  console.log('PASS: work-orders=1, board=1, todos=200')
  for (const path of ['/', '/m']) {
    const page = await request(path)
    assert.equal(page.status, 200)
    assert(page.text.includes('独立单工单测试'))
    assert(page.text.includes('QMS 写回及自动任务已禁用'))
  }
  console.log('PASS: PC / and mobile /m HTML load with sandbox title (not visual/device acceptance)')
  const cancelled = await request('/api/work-orders/SANDBOX-ONLY-001/cancel', { method: 'POST', body: { version: 1 } })
  assert.equal(cancelled.status, 400)
  assert(cancelled.text.includes('业务写回与同步已禁用'))
  for (const [method, path] of [['POST', '/api/integration/fulfillment/work-orders'], ['PUT', '/api/integration/fulfillment/work-orders/SANDBOX-ONLY-001'], ['POST', '/api/integration/fulfillment/work-orders/SANDBOX-ONLY-001/cancel'], ['GET', '/api/integration/fulfillment/work-orders']]) {
    const response = await fetch(env.NUXT_QMS_API_BASE + path, { method })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'SANDBOX_WRITE_DISABLED')
  }
  console.log('PASS: actual cancel API shows explicit disabled message; stub rejects create/update/cancel/sync')
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL })
  try {
    assert.equal((await db.$queryRawUnsafe('SELECT DATABASE() AS db'))[0].db, env.SANDBOX_DATABASE)
    assert.equal(await db.qmsWorkOrder.count(), 1)
    assert.equal(await db.qmsUser.count(), 1)
    assert.equal((await db.qmsWorkOrder.findUnique({ where: { workOrderNumber: 'SANDBOX-ONLY-001' } })).status, 'IN_PROGRESS')
    assert.equal((await db.qmsUser.findUnique({ where: { id: 'sandbox-pm' } })).realName, '【独立测试】项目经理')
    const session = await db.session.findUnique({ where: { id: createHash('sha256').update(cookies.get('ft_session')).digest('hex') } })
    assert.equal(session.qmsUserId, 'sandbox-pm')
    console.log('PASS: exact database identity, orders=1, users=1, session identity matches fixture; order unchanged')
  } finally { await db.$disconnect() }
} catch (error) { console.error('FAIL:', error.name, error.code ?? '', 'No sensitive request/response values printed'); process.exitCode = 1 }
