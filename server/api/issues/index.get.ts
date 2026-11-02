import { z } from 'zod'
import { listIssues, myDepartmentIds } from '../../services/issues/issues'
import { category } from '../../schemas/issues'

const query = z.object({
  status: z.enum(['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED', 'UNCLOSED']).optional(),
  category: category.optional(),
  workOrderNumber: z.string().max(64).optional(),
  /** 1 = 本部门（我担任负责人的部门 + 我所在部门） */
  dept: z.enum(['0', '1']).optional(),
  mine: z.enum(['responsible', 'reported', 'todo']).optional(),
  overdue: z.enum(['0', '1']).optional(),
})

/** 异常列表：按状态、分类、工单、本部门、我负责/我上报/等我处理筛选；只列可见工单的 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listIssues(
    {
      status: q.status,
      category: q.category,
      workOrderNumber: q.workOrderNumber || undefined,
      deptIds: q.dept === '1' ? await myDepartmentIds(user.qmsUserId) : undefined,
      mine: q.mine,
      overdue: q.overdue === '1',
      visibleWorkOrders: scopeWorkOrders(await getScope(event)),
    },
    actorOf(event, user),
  )
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestQuery = z.input<typeof query>
