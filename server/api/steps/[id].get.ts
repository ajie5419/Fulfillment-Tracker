import { getStep } from '../../services/flow/steps'

export default defineFlowHandler(async (event, user) => {
  const step = await getStep(routeId(event))
  assertCanSee(user, step.part.workOrderNumber)
  return step
})
