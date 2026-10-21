import { updateTask } from '../../services/drawings/drawings'
import { patchTaskBody } from '../../schemas/drawings'

/** 修改设计任务（含关联工件、负责人、计划日、客户确认要求、取消 / 重新启用）。技术部、管理员（能看到该工单） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id)
  await assertCanOperateDrawing(event, id)
  return updateTask(id, await parseBody(event, patchTaskBody))
})
