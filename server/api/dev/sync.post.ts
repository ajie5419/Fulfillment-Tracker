import { runSyncJob } from '../../services/sync/job'

/** 立即同步一次 QMS（同步 → 返厂匹配 → 不合格转异常），与定时任务共用租约锁。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return runSyncJob({ config: qmsSyncConfig(event), adminIds: adminIds(event) })
})
