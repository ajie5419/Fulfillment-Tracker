import { z } from 'zod'
import { importBom } from '../../services/bom/import'
import { loadWorkOrderBom } from '../../services/bom/source'

const body = z
  .object({
    workOrderNumber: z.string().min(1).max(64),
    bomIds: z.array(z.string().min(1).max(191)).min(1, '请勾选要导入的零件').max(500),
  })
  .strict()

/** 导入勾选的 BOM 行：服务端重新从 QMS 读一次（不用浏览器传来的内容），整批一个事务；已导入过的跳过。生产部、外协专员、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber, bomIds } = await parseBody(event, body)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'route', { workOrderNumber })
  const rows = await loadWorkOrderBom(workOrderNumber, { config: qmsSyncConfig(event), devTools: Boolean(useRuntimeConfig(event).devTools) })
  return importBom(workOrderNumber, rows, bomIds)
})
