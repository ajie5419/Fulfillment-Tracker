import { getPanorama } from '../services/issues/panorama'

/** 项目全景：权限和可见范围跟随 /api/board。 */
export default defineFlowHandler(async (event) => getPanorama(scopeWorkOrders(await getScope(event))))
