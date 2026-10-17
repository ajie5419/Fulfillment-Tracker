import { z } from 'zod'
import { addNotifyRole } from '../../../services/alerts/settings'

const body = z
  .object({
    role: z.enum(['OUTSOURCE_COORDINATOR', 'DEPT_HEAD', 'PROJECT_DEPT_HEAD', 'LEADER', 'FINANCE']),
    userId: z.string().min(1, '请选择人员').max(64),
    department: z.string().max(191).nullish(),
  })
  .strict()

/** 添加通知对象。仅管理员 */
export default defineAdminHandler(async (event) => addNotifyRole(await parseBody(event, body)))
