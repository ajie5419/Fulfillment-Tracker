import { deletePart } from '../../services/flow/steps'

export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  return deletePart(id)
})
