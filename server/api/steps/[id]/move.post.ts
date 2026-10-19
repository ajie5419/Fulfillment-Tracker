import { z } from 'zod'
import { moveStep } from '../../../services/flow/steps'

const body = z.object({ direction: z.enum(['up', 'down']) }).strict()

/** 调整工序顺序（上移/下移）：属于改工序链，生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const { direction } = await parseBody(event, body)
  const id = routeId(event)
  await assertCanSeeStep(event, id)
  await assertCanOperateStep(event, 'route', id)
  return moveStep(id, direction)
})
