import { deleteStep } from '../../services/flow/steps'

/** 删除工序：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeStep(event, id)
  await assertCanOperateStep(event, 'route', id)
  return deleteStep(id)
})
