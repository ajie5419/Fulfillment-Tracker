import { z } from 'zod'
import { setProjectManager } from '../../../services/alerts/settings'

const body = z.object({ projectManagerId: z.string().max(64).nullable() }).strict()

/** 设置工单的项目经理（work_order_ext.projectManagerId）。仅管理员 */
export default defineAdminHandler(async (event) => {
  const { projectManagerId } = await parseBody(event, body)
  return setProjectManager(routeId(event, 'wo'), projectManagerId || null)
})
