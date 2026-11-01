import { z } from 'zod'
import { listMyReceipts } from '../../services/releases/releases'

const query = z.object({ tab: z.enum(['pending', 'done']).default('pending') })

/** 我的签收（手机）：待签收 / 已处理 */
export default defineFlowHandler(async (event, user) => listMyReceipts(user.qmsUserId, parseQuery(event, query).tab))

/** 客户端请求契约（仅类型导出）。 */
export type RequestQuery = z.input<typeof query>
