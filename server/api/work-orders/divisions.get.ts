import { listDivisions } from '../../services/workorder/manage'

/** 新建 / 编辑工单的事业部下拉：本地已同步的 QMS 部门。项目部、管理员 */
export default defineFlowHandler(async (event) => listDivisions(await getRoleContext(event)))
