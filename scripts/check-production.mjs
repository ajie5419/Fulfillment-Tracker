import { access, constants } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { productionConfigErrors } from '../shared/production-config.mjs'

/** Runs inside the release image, with the same network and volume as the app. */
async function main() {
  const invalid = productionConfigErrors(process.env)
  if (invalid.length) throw new Error(`Invalid production fields: ${invalid.join(', ')}`)
  try {
    execFileSync('prisma', ['db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'], { input: 'SELECT 1;', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 })
  } catch { throw new Error('Database connection failed; check connectivity and grants (credentials suppressed)') }
  await access(process.env.NUXT_UPLOAD_DIR, constants.W_OK)
  try {
    const response = await fetch(process.env.NUXT_QMS_API_BASE.replace(/\/$/, '') + '/api/status', { signal: AbortSignal.timeout(5000), redirect: 'error' })
    await response.body?.cancel()
    if (!response.ok) throw new Error()
  } catch { throw new Error('QMS status probe failed; verify network and QMS service') }
  console.log('PASS production configuration, database connection, upload permissions and QMS reachability; identity authorization still requires acceptance.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
