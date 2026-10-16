import { z } from 'zod'
import { acceptIssue } from '../../../services/issues/issues'
import { assignFields, definedOnly } from '../../../schemas/issues'

const body = z.object(assignFields).strict()

/** 受理：待受理 → 处理中，可同时改责任人/要求解决日；没有要求解决日时默认受理后 3 天 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return acceptIssue(id, actorOf(event, user), definedOnly(await parseBody(event, body)))
})
