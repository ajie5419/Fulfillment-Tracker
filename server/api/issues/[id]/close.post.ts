import { closeIssue } from '../../../services/issues/issues'
import { optionalNoteBody } from '../../../schemas/issues'

/** 确认关闭：待确认 → 已关闭（关联步骤没有其他未关闭异常时恢复） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeIssue(event, id)
  return closeIssue(id, actorOf(event, user), (await parseBody(event, optionalNoteBody)).note)
})
