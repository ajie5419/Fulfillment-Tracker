import { describe, expect, it } from 'vitest'
import { productionConfigErrors } from '../../shared/production-config.mjs'
import { healthy, validateDeployment } from '../../scripts/production.mjs'

const env = {
  FT_DEPLOYMENT_MODE: 'production', DATABASE_URL: 'mysql://app:synthetic@db:3306/fulfillment',
  NUXT_DEV_TOOLS: '0', NUXT_ISOLATED_DEMO: '0', NUXT_SANDBOX: '0', NUXT_QMS_SYNC_ENABLED: '1',
  NUXT_QMS_CLIENT_ID: 'fulfillment', NUXT_QMS_CLIENT_SECRET: 'synthetic-credential-for-tests-only',
  NUXT_QMS_API_BASE: 'http://qms-backend:3000', NUXT_QMS_AUTHORIZE_URL: 'https://qms.example.invalid/#/identity/authorize',
  NUXT_QMS_CALLBACK_URL: 'https://ft.example.invalid/auth/callback', NUXT_ADMIN_USER_IDS: 'admin-1', NUXT_UPLOAD_DIR: '/app/data/uploads',
  GRAFANA_ADMIN_PASSWORD: 'synthetic-admin-password', ALERT_EMAIL_FROM: 'sender@example.invalid', ALERT_EMAIL_TO: 'recipient@example.invalid',
  ALERT_SMTP_ADDRESS: 'smtp.example.invalid:587', ALERT_SMTP_USERNAME: 'fixture', ALERT_SMTP_PASSWORD: 'synthetic-mail-password',
  ALERT_PUBLIC_HEALTH_URL: 'https://ft.example.invalid/api/health',
}
describe('first production deployment policy', () => {
  it('accepts isolated production credentials and HTTPS identity callbacks', () => {
    expect(productionConfigErrors(env)).toEqual([])
    expect(() => validateDeployment(env)).not.toThrow()
  })
  it.each(['NUXT_DEV_TOOLS', 'NUXT_ISOLATED_DEMO', 'NUXT_SANDBOX'])('rejects enabled or omitted %s', key => {
    expect(productionConfigErrors({ ...env, [key]: '1' })).toContain(key)
    expect(productionConfigErrors({ ...env, [key]: undefined })).toContain(key)
  })
  it.each(['mysql://root:password@db/fulfillment', 'mysql://app:password@db/fulfillment_demo', 'mysql://app@db/fulfillment', 'mysql://app:password@db/fulfillment_test'])('rejects unsafe database identity %s', DATABASE_URL => {
    expect(productionConfigErrors({ ...env, DATABASE_URL })).toContain('DATABASE_URL')
  })
  it('rejects missing admins, disabled sync and placeholder secrets without leaking values', () => {
    const errors = productionConfigErrors({ ...env, NUXT_ADMIN_USER_IDS: '', NUXT_QMS_SYNC_ENABLED: '0', NUXT_QMS_CLIENT_SECRET: 'CHANGE_ME' })
    expect(errors).toEqual(expect.arrayContaining(['NUXT_ADMIN_USER_IDS', 'NUXT_QMS_SYNC_ENABLED', 'NUXT_QMS_CLIENT_SECRET']))
    expect(errors.join(' ')).not.toContain('CHANGE_ME')
  })
  it('rejects monitoring for another application origin', () => {
    expect(() => validateDeployment({ ...env, ALERT_PUBLIC_HEALTH_URL: 'https://other.invalid/api/health' })).toThrow('ALERT_PUBLIC_HEALTH_URL')
  })
  it('rejects an ephemeral upload path outside the mounted volume', () => {
    expect(productionConfigErrors({ ...env, NUXT_UPLOAD_DIR: '/tmp/uploads' })).toContain('NUXT_UPLOAD_DIR')
  })
  it('does not mistake HTTP 200 HTML or a failed envelope for readiness', async () => {
    expect(await healthy('https://fixture.invalid', async () => new Response('<html>Error</html>'))).toBe(false)
    expect(await healthy('https://fixture.invalid', async () => Response.json({ code: 'FAILED', data: { ok: true } }))).toBe(false)
    expect(await healthy('https://fixture.invalid', async () => Response.json({ code: 0, data: { ok: true } }))).toBe(true)
  })
})
