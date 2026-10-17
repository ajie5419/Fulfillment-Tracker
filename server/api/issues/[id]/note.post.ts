import { addIssueNote } from '../../../services/issues/issues'
import { noteBody } from '../../../schemas/issues'

/** 加备注（状态不变） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return addIssueNote(id, actorOf(event, user), (await parseBody(event, noteBody)).note)
})
