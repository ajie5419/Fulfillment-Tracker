import { deleteTemplate } from '../../services/templates/templates'

/** 删除模板（仅管理员）。已套用到工件上的工序不受影响 */
export default defineAdminHandler(async (event) => deleteTemplate(routeId(event)))
