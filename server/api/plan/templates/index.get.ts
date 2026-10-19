import { listTemplates } from '../../../services/plan/templates'

/** 总计划模板列表（按模板生成时选；所有登录用户可看） */
export default defineFlowHandler(async () => listTemplates())
