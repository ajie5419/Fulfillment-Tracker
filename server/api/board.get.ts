import { z } from 'zod'
import { getBoard } from '../services/issues/board'
import { syncConfigured } from '../services/sync/client'

const query = z.object({ closed: z.enum(['0', '1']).optional() })

/** 看板：可见工单的红黄绿、外协在途、超期、未关闭异常；QMS 最后同步时间（syncConfigured = 是否配置了 QMS 同步）。
 * 默认只算在做的工单；?closed=1 另把已完工 / 已取消的也列出（行上 closed = true，不进分组和汇总） */
export default defineFlowHandler(async (event) => {
  const { closed } = parseQuery(event, query)
  const board = await getBoard(scopeWorkOrders(await getScope(event)), new Date(), { withClosed: closed === '1' })
  return { ...board, syncConfigured: syncConfigured(qmsSyncConfig(event)) }
})
