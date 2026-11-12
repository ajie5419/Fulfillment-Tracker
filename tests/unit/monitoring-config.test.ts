import { expect, it } from 'vitest'
// The operational script is plain Node ESM, intentionally independent of Nuxt.
import { monitoringConfig } from '../../scripts/render-monitoring-config.mjs'
import { inspectArchitecture } from '../../scripts/architecture-rules.mjs'

const env = { ALERT_EMAIL_FROM: 'sender@example.invalid', ALERT_EMAIL_TO: 'recipient@example.invalid', ALERT_SMTP_ADDRESS: 'smtp.example.invalid:587', ALERT_SMTP_USERNAME: 'fixture' }
it('requires explicit email configuration, enforces TLS, and never embeds a password', () => {
  expect(() => monitoringConfig({})).toThrow('ALERT_EMAIL_FROM')
  expect(() => monitoringConfig({ ...env, ALERT_EMAIL_TO: 'x\nInjected' })).toThrow()
  const config = monitoringConfig(env)
  expect(config.global.smtp_require_tls).toBe(true)
  expect(config.global.smtp_auth_password_file).toBe('/etc/alertmanager/smtp-password')
  expect(config.global).not.toHaveProperty('smtp_auth_password')
})
it('prevents unstructured server console output from returning', () => {
  expect(inspectArchitecture('server/services/example.ts', 'console.error(error)')).toEqual([expect.stringContaining('structured-logging')])
  expect(inspectArchitecture('server/services/example.ts', "logEvent('error', 'operation.failed', {}, error)")).toEqual([])
})
