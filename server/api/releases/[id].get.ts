import { assertCanViewRelease, getRelease } from '../../services/releases/releases'

/** 发放单详情：能看该工单的人，或接收人 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  const scope = await getScope(event)
  await assertCanViewRelease(id, user.qmsUserId, (wo) => canSee(scope, wo))
  return getRelease(id, actorOf(event, user))
})
