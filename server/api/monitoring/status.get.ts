import { canSeeOverview } from '../../services/auth/permissions'
import { FlowForbidden } from '../../services/flow/errors'
import { getStatusMonitoring } from '../../services/monitoring/status'

/** 管理状态监控：权限与领导总览一致，范围是全部在履约工单。 */
export default defineFlowHandler(async (event) => {
  if (!canSeeOverview(await getRoleContext(event))) throw new FlowForbidden('状态监控仅领导、项目部负责人和管理员可以查看')
  return getStatusMonitoring()
})
