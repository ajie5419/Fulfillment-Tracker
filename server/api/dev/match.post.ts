import { matchPendingInspections } from '../../services/flow/match'
import { syncNonconforming } from '../../services/issues/nonconforming'

/** 立即跑一轮报检匹配，接着跑 QMS 不合格转异常（同步任务每轮也会做）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  const matched = await matchPendingInspections()
  return { matched, nonconforming: await syncNonconforming() }
})
