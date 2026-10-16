import { listMyTodos } from '../../services/flow/todos'

/** 我的待办（只列可见工单上的） */
export default defineFlowHandler(async (event, user) => listMyTodos(user.qmsUserId, scopeWorkOrders(await getScope(event))))
