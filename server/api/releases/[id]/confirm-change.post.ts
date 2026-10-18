import { assertCanViewRelease, confirmChange } from '../../../services/releases/releases'
import { confirmBody } from '../../../schemas/releases'

/** 确认设计变更影响：收到"确认变更影响"待办的人、发放人或管理员；确认后解除"等变更" */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  const { note } = await parseBody(event, confirmBody)
  const scope = await getScope(event)
  await assertCanViewRelease(id, user.qmsUserId, (wo) => canSee(scope, wo))
  return confirmChange(id, actorOf(event, user), note ?? null)
})
