import { listEvents } from '../../../services/flow/steps'

/** 工件的流转记录（只读） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  return listEvents(id)
})
