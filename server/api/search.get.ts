import { z } from 'zod'
import { search } from '../services/search/search'

const query = z.object({ q: z.string().max(64).default('') })

/** 全局搜索（页头搜索框）：工单、工件 / 图号、采购物料 / 供应商、外协厂 / 班组；只搜可见工单 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  return search(q.q, scopeWorkOrders(await getScope(event)))
})
