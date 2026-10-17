import { markDrawn } from '../../../services/drawings/drawings'
import { dateBody } from '../../../schemas/drawings'

/** 标记出图：设计负责人本人或管理员（服务层判断）。出图日默认今天 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  const { date } = await parseBody(event, dateBody)
  return markDrawn(id, date, actorOf(event, user))
})
