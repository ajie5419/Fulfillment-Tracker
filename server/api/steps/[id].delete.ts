import { deleteStep } from '../../services/flow/steps'

export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeStep(event, id)
  return deleteStep(id)
})
