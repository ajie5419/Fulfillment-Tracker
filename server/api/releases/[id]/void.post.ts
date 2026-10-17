import { assertCanViewRelease, voidRelease } from '../../../services/releases/releases'

/** 作废发放单：发放人或管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  const scope = await getScope(event)
  await assertCanViewRelease(id, user.qmsUserId, (wo) => canSee(scope, wo))
  return voidRelease(id, actorOf(event, user))
})
