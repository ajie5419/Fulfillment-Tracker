#!/usr/bin/env node
/** 用 mkcert 生成受本机信任的 https://localhost 证书，放在 certs/（不提交）。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

try {
  execFileSync('mkcert', ['-version'], { stdio: 'ignore' })
} catch {
  console.error('未找到 mkcert。macOS：brew install mkcert nss')
  process.exit(1)
}
mkdirSync('certs', { recursive: true })
execFileSync('mkcert', ['-install'], { stdio: 'inherit' })
execFileSync(
  'mkcert',
  ['-key-file', 'certs/localhost-key.pem', '-cert-file', 'certs/localhost.pem', 'localhost', '127.0.0.1', '::1'],
  { stdio: 'inherit' },
)
console.log('已生成 certs/localhost.pem，.env 中 DEV_HTTPS_KEY / DEV_HTTPS_CERT 指向它们后运行 pnpm dev')
