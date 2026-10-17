import { getStep } from '../../services/flow/steps'

export default defineFlowHandler(async (event) => {
  const step = await getStep(routeId(event))
  await assertCanSee(event, step.part.workOrderNumber)
  return step
})
