import { rejectIssue } from '../../../services/issues/issues'
import { noteBody } from '../../../schemas/issues'

/** 退回：待确认 → 处理中 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return rejectIssue(id, actorOf(event, user), (await parseBody(event, noteBody)).note)
})
