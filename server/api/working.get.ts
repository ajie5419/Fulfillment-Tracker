import { z } from 'zod'
import { listWorking } from '../services/flow/working'

const query = z.object({ mine: z.enum(['1', '0']).optional() })

/** 加工中的自制 / 厂内外协工序（手机端"加工中"页）；mine=1 只看自己负责的。只列可见工单 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listWorking({
    ownerId: q.mine === '0' ? undefined : user.qmsUserId,
    visibleWorkOrders: scopeWorkOrders(await getScope(event)),
  })
})
