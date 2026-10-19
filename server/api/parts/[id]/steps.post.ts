import { z } from 'zod'
import { addStep } from '../../../services/flow/steps'
import { stepFields } from '../../../schemas/flow'

const body = z.object(stepFields).strict()

/** 在工序链末尾加一道：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  await assertCanOperatePart(event, 'route', id)
  return addStep(id, await parseBody(event, body), user.qmsUserId)
})
