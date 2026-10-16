import { resolveIssue } from '../../../services/issues/issues'
import { noteBody } from '../../../schemas/issues'

/** 填处理结果：处理中 → 待确认 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return resolveIssue(id, actorOf(event, user), (await parseBody(event, noteBody)).note)
})
