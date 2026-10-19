import { createNode } from '../../services/kitting/kitting'
import { newNodeBody } from '../../schemas/kitting'

/** 新建装配节点：能看到该工单，且是生产经理、该工单项目经理或管理员（服务层判断） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newNodeBody)
  await assertCanSee(event, input.workOrderNumber)
  const node = await createNode(input, actorOf(event, user))
  return { id: node.id, planWarning: node.planWarning }
})
