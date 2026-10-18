import { z } from 'zod'
import { saveTemplateFromPart } from '../../../services/templates/templates'

const body = z.object({ name: z.string().trim().min(1, '请填写模板名称').max(191), description: z.string().trim().max(2000).nullish() }).strict()

/** 把工件当前的工序链另存为模板（模板维护仅管理员） */
export default defineAdminHandler(async (event, user) => saveTemplateFromPart(routeId(event), await parseBody(event, body), user.qmsUserId))
