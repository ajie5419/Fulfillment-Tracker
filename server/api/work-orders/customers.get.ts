import { listCustomers } from '../../services/workorder/manage'

/** 新建 / 编辑工单的客户下拉：现取 QMS 客户字典（不在本地存）。项目部、管理员 */
export default defineFlowHandler(async (event) => listCustomers(await getRoleContext(event), qmsWorkOrderApi(event)))
