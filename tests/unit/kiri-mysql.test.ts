import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dockerCommand, ensureMysql, inspectMysql, kiri, mysqlSql, mysqlTarget } from '../../scripts/kiri-mysql.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
const exec = vi.mocked(execFileSync)
beforeEach(() => exec.mockReset())

describe('Kiri local database boundary', () => {
  it('uses the bundled CLI and an explicit Kiri socket, ignoring inherited engine selection', () => {
    expect(dockerCommand(() => true)).toBe('/Applications/Kiri.app/Contents/Resources/bin/docker')
    expect(dockerCommand(() => false)).toBe('docker')
    kiri(['ps'], { env: { DOCKER_CONTEXT: 'production', DOCKER_HOST: 'tcp://remote:2375' } })
    const [, args, options] = exec.mock.calls[0]!
    expect(args).toContain('--config')
    expect(args).toContain('--host')
    expect(args?.some(arg => String(arg).endsWith('/.kiri/run/docker.sock'))).toBe(true)
    expect(options?.env?.DOCKER_CONTEXT).toBeUndefined()
    expect(options?.env?.DOCKER_HOST).toBeUndefined()
  })

  it('keeps test and demo databases on distinct containers and ports', () => {
    expect(mysqlTarget('demo')).toEqual({ name: 'ft-demo-mysql', port: 13307, database: 'fulfillment_demo' })
    expect(mysqlTarget('test')).toEqual({ name: 'ft-test-mysql', port: 13308, database: 'fulfillment_test' })
    expect(() => mysqlTarget('production')).toThrow()
    mysqlSql('test', 'SELECT 1;')
    expect(exec.mock.calls[0]?.[1]).toContain('ft-test-mysql')
    expect(exec.mock.calls[0]?.[2]?.input).toBe('SELECT 1;')
  })

  it.each([
    ['demo', '127.0.0.1', '13308'],
    ['test', '127.0.0.1', '13307'],
    ['demo', '0.0.0.0', '13307'],
  ])('rejects a mismatched label or port binding', (label, host, port) => {
    exec.mockReturnValue(`${JSON.stringify({ 'app.fulfillment.local-mysql': label })}|${JSON.stringify({ '3306/tcp': [{ HostIp: host, HostPort: port }] })}|true`)
    expect(() => inspectMysql('demo')).toThrow('identity or port mismatch')
  })

  it('does not create missing databases or containers in preflight mode', async () => {
    exec.mockReturnValue('')
    await expect(ensureMysql('demo', { checkOnly: true })).rejects.toThrow('not prepared')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]?.[1]).toContain('ps')
  })

  it('refuses to silently attach an orphaned data volume', async () => {
    exec.mockReturnValueOnce('').mockReturnValueOnce('ft-demo-mysql-data\n')
    await expect(ensureMysql('demo')).rejects.toThrow('explicit recovery')
    expect(exec).toHaveBeenCalledTimes(2)
  })
})
