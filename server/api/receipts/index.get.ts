import { z } from 'zod'
import { listMyReceipts } from '../../services/releases/releases'

const query = z.object({ tab: z.enum(['pending', 'done']).default('pending') })

/** 我的签收（手机）：待签收 / 已处理 */
export default defineFlowHandler(async (event, user) => listMyReceipts(user.qmsUserId, parseQuery(event, query).tab))
