import { z } from 'zod'
import { updatePart } from '../../services/flow/steps'
import { partFields } from '../../schemas/flow'

const body = z.object(partFields).partial().strict()

/** 修改工件：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  await assertCanOperatePart(event, 'route', id)
  return updatePart(id, await parseBody(event, body))
})
