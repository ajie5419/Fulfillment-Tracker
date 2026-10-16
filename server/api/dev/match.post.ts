import { matchPendingInspections } from '../../services/flow/match'

/** 立即跑一轮报检匹配（R2 以后由同步任务调用）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return matchPendingInspections()
})
