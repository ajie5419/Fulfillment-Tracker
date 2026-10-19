import { undoCompleteNode } from '../../../../services/plan/plan'

/** 撤销手动完成：该节点责任部门的人、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'planNodeDone', id)
  return undoCompleteNode(id)
})
