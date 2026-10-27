import { z } from 'zod'
import { listWorking } from '../services/flow/working'

const query = z.object({ mine: z.enum(['1', '0']).optional() })

/** 加工中的自制 / 厂内外协工序（手机端"加工中"页）；mine=1 只看我的（本人负责的 + 本班组的自制工序）。只列可见工单 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listWorking({
    mine: q.mine === '0' ? undefined : { userId: user.qmsUserId, teamIds: (await getRoleContext(event)).leadOf ?? [] },
    visibleWorkOrders: scopeWorkOrders(await getScope(event)),
  })
})
