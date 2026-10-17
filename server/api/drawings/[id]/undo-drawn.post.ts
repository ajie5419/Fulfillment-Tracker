import { undoDrawn } from '../../../services/drawings/drawings'

/** 撤销出图（标错了）：设计负责人本人或管理员；已发放的要先作废发放单 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeeDrawing(event, id, user)
  return undoDrawn(id, actorOf(event, user))
})
