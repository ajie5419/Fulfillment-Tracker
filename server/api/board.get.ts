import { getBoard } from '../services/issues/board'

/** 看板：可见工单的红黄绿、外协在途、超期、未关闭异常；QMS 最后同步时间 */
export default defineFlowHandler(async (event) => getBoard(scopeWorkOrders(await getScope(event))))
