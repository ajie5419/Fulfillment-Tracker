import { ignoreUnmatched } from '../../../services/flow/match'

export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeInspection(event, id)
  return ignoreUnmatched(id, user.qmsUserId)
})
