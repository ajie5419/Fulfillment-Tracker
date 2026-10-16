import { ignoreUnmatched } from '../../../services/flow/match'

export default defineFlowHandler(async (event, user) => ignoreUnmatched(routeId(event), user.qmsUserId))
