import { z } from 'zod'
import { transferTodo } from '../../../services/flow/todos'

const body = z.object({ toUserId: z.string().min(1, '请选择转交对象').max(64) }).strict()

/** 转交给某人 */
export default defineFlowHandler(async (event) => {
  const { toUserId } = await parseBody(event, body)
  return transferTodo(routeId(event), toUserId)
})
