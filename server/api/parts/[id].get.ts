import { getPart } from '../../services/flow/steps'
import { loadPrereqs } from '../../services/flow/workshop'

/** 单个工件（全站共用的工件抽屉）：基本信息、工序链（带名称、已完成数量、异常）、关联记录数、开工前提（物料 / 设计还缺几项） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  const part = await getPart(id)
  const prereq = (await loadPrereqs([id])).get(id)!
  return { ...part, prereq }
})
