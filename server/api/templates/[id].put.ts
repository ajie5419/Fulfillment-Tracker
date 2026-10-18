import { updateTemplate } from '../../services/templates/templates'
import { templateBody } from '../../schemas/templates'

/** 修改模板（仅管理员）。已套用到工件上的工序不受影响 */
export default defineAdminHandler(async (event) => updateTemplate(routeId(event), await parseBody(event, templateBody)))
