import { z } from 'zod'
import { reassignIssue } from '../../../services/issues/issues'
import { assignFields, definedOnly } from '../../../schemas/issues'

const body = z.object(assignFields).strict()

/** 改派：改责任部门/责任人/外协单位/要求解决日（待受理、处理中） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return reassignIssue(id, actorOf(event, user), definedOnly(await parseBody(event, body)))
})
