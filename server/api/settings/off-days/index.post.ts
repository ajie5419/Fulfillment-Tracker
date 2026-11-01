import { z } from 'zod'
import { addOffDay } from '../../../services/alerts/settings'
import { day } from '../../../schemas/flow'

const body = z.object({ date: day }).strict()

/** 加一个停工日。仅管理员 */
export default defineAdminHandler(async (event) => addOffDay((await parseBody(event, body)).date))

/** 客户端请求契约（仅类型导出）。 */
export type RequestBody = z.input<typeof body>
