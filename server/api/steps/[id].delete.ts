import { deleteStep } from '../../services/flow/steps'

export default defineFlowHandler(async (event) => deleteStep(routeId(event)))
