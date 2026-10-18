import { updateTask } from '../../services/drawings/drawings'
import { patchTaskBody } from '../../schemas/drawings'

/** 修改出图任务（含关联工件、负责人、计划日、客户确认要求、取消 / 重新启用）。能看到该工单的人都可以改 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id)
  return updateTask(id, await parseBody(event, patchTaskBody))
})
