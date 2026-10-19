import { removeNotifyRole } from '../../../services/alerts/settings'

/** 移除人员角色（通知对象）。仅管理员 */
export default defineAdminHandler(async (event) => removeNotifyRole(routeId(event)))
