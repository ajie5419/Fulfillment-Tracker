import { syncConfigured } from '../../services/sync/client'
import { syncStatus } from '../../services/sync/status'

/** 设置页"QMS 同步状态"：每类资源的最后同步时间、游标、最近错误、连续失败次数。仅管理员 */
export default defineAdminHandler(async (event) => ({ configured: syncConfigured(qmsSyncConfig(event)), resources: await syncStatus() }))
