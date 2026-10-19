import { createTask } from '../../services/drawings/drawings'
import { newTaskBody } from '../../schemas/drawings'

/** 新建出图任务：技术部、管理员（能看到该工单） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newTaskBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'drawing', { workOrderNumber: input.workOrderNumber })
  const task = await createTask(input, user.qmsUserId)
  return { id: task.id, planWarning: task.planWarning }
})
