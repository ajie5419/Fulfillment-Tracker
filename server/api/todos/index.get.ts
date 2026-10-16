import { listMyTodos } from '../../services/flow/todos'

/** 我的待办 */
export default defineFlowHandler(async (_event, user) => listMyTodos(user.qmsUserId))
