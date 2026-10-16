import { getSettings } from '../../services/alerts/settings'

/** 设置页数据：阈值、停工日、通知对象、工单项目经理。仅管理员 */
export default defineAdminHandler(async () => getSettings())
