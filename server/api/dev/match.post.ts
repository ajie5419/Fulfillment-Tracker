import { matchPendingInspections } from '../../services/flow/match'
import { syncNonconforming } from '../../services/issues/nonconforming'
import { matchIncomingInspections } from '../../services/purchases/incoming'

/** 立即跑一轮报检匹配、进货检验确认到货，接着跑 QMS 不合格转异常（同步任务每轮也会做）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  const matched = await matchPendingInspections()
  const incoming = await matchIncomingInspections()
  return { matched, incoming, nonconforming: await syncNonconforming() }
})
