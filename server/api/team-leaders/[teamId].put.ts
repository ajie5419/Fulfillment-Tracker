import { z } from 'zod'
import { setTeamLeader } from '../../services/flow/team-leaders'

const body = z.object({ userId: z.string().min(1).max(64).nullable() }).strict()

/** 设置 / 清除班组长（userId = null 清除）：生产部、管理员 */
export default defineFlowHandler(async (event, user) => {
  await assertCanOperate(event, 'teamLeader')
  const teamId = routeId(event, 'teamId')
  const b = await parseBody(event, body)
  return setTeamLeader(teamId, b.userId, user.qmsUserId)
})
