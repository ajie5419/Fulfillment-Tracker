import { canSeeOverview } from '../services/auth/permissions'
import { FlowForbidden } from '../services/flow/errors'
import { getOverview } from '../services/issues/overview'

/** 领导总览：仅领导、项目部负责人、管理员（其他人 403）。数据与看板同源，范围是全部工单 */
export default defineFlowHandler(async (event) => {
  if (!canSeeOverview(await getRoleContext(event))) throw new FlowForbidden('领导总览仅领导、项目部负责人和管理员可以查看')
  return getOverview()
})
