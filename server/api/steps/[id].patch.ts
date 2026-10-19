import { z } from 'zod'
import { updateStep } from '../../services/flow/steps'
import { stepFields } from '../../schemas/flow'

const body = z.object(stepFields).partial().strict()

/** 修改工序：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeStep(event, id)
  await assertCanOperateStep(event, 'route', id)
  return updateStep(id, await parseBody(event, body))
})
