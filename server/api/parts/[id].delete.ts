import { deletePart } from '../../services/flow/steps'

export default defineFlowHandler(async (event) => deletePart(routeId(event)))
