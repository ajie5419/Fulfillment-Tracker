import { seedDemo } from '../../services/dev/demo'
import { syncConfigured } from '../../services/sync/client'

/** 写入演示数据（幂等）。配置了 QMS 同步时不写演示用户（用户以 QMS 为准）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return seedDemo({ skipUsers: syncConfigured(qmsSyncConfig(event)) })
})
