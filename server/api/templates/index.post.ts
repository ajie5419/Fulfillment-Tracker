import { createTemplate } from '../../services/templates/templates'
import { templateBody } from '../../schemas/templates'

/** 新建模板（仅管理员） */
export default defineAdminHandler(async (event, user) => createTemplate(await parseBody(event, templateBody), user.qmsUserId))
