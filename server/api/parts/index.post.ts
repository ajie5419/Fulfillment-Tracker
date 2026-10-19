import { z } from 'zod'
import { createPart } from '../../services/flow/steps'
import { partFields } from '../../schemas/flow'

const body = z.object({ workOrderNumber: z.string().min(1).max(64), ...partFields }).strict()

/** 新建工件：生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber, ...input } = await parseBody(event, body)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'route', { workOrderNumber })
  return createPart(workOrderNumber, input)
})
