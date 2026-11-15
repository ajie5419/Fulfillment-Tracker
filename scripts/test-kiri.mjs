import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { buildLocalImage, kiri, kiriProgress } from './kiri-mysql.mjs'

process.chdir(resolve(import.meta.dirname, '..'))
const project = `ft-test-${randomBytes(6).toString('hex')}`
const image = `ft-local:${project}`
const password = randomBytes(24).toString('hex')
const rootPassword = randomBytes(24).toString('hex')
const env = { FT_LOCAL_IMAGE: image, FT_TEST_PASSWORD: password, FT_TEST_ROOT_PASSWORD: rootPassword }
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'docker-compose.test.yml']
let failed = false
const cleanup = () => {
  try { kiri([...compose, 'down', '--volumes', '--remove-orphans'], { env }) }
  catch { failed = true; console.error(`测试资源清理失败，请检查 Compose 项目 ${project}。`) }
  try { kiri(['image', 'rm', image]) } catch { /* The build may not have produced an image. */ }
}
// Only this run's random project is removed, including after an interrupted test run.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130) })
try {
  await buildLocalImage(image)
  console.log('在 Docker 中运行质量门禁、类型检查、前端单元测试及真实 MySQL 集成测试。')
  await kiriProgress([...compose, 'up', '--no-build', '--abort-on-container-exit', '--exit-code-from', 'tests'], env, [password, rootPassword])
} catch {
  failed = true
  console.error('Docker 测试失败；以上输出已隐藏临时凭据。演示数据库未参与测试。')
} finally { cleanup() }
if (failed) process.exitCode = 1
