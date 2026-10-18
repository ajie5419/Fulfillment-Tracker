import { listTemplates } from '../../services/templates/templates'

/** 工序路线模板列表（登录即可看，套用时要选） */
export default defineFlowHandler(async () => listTemplates())
