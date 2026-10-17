import { nodeOptions } from '../../services/kitting/kitting'
import { optionsQuery } from '../../schemas/kitting'

/** 编辑节点清单的下拉选项：该工单的工件和关键物料 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber } = parseQuery(event, optionsQuery)
  await assertCanSee(event, workOrderNumber)
  return nodeOptions(workOrderNumber)
})
