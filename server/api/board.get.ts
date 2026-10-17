import { getBoard } from '../services/issues/board'
import { syncConfigured } from '../services/sync/client'

/** 看板：可见工单的红黄绿、外协在途、超期、未关闭异常；QMS 最后同步时间（syncConfigured = 是否配置了 QMS 同步） */
export default defineFlowHandler(async (event) => {
  const board = await getBoard(scopeWorkOrders(await getScope(event)))
  return { ...board, syncConfigured: syncConfigured(qmsSyncConfig(event)) }
})
