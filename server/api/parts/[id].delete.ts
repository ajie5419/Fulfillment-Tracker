import { deletePart } from '../../services/flow/steps'

/** 删除工件：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  await assertCanOperatePart(event, 'route', id)
  return deletePart(id)
})
