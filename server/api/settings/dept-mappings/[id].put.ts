import { z } from 'zod'
import { setDeptMapping } from '../../../services/alerts/settings'

const body = z.object({ businessDept: z.enum(['TECH', 'PROCESS', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT']).nullable() }).strict()

/** 设置一个 QMS 部门对应的业务部门（null = 不对应）。仅管理员 */
export default defineAdminHandler(async (event) => setDeptMapping(routeId(event), (await parseBody(event, body)).businessDept))

/** 客户端请求契约（仅类型导出）。 */
export type RequestBody = z.input<typeof body>
