import { z } from 'zod'
import { previewBom } from '../../services/bom/import'
import { loadWorkOrderBom } from '../../services/bom/source'

const query = z.object({ workOrderNumber: z.string().min(1).max(64) })

/** 从 QMS 实时读工单 BOM 供勾选（服务端调用，凭据不出服务器）；标出已导入的行和无法建步骤的工序 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber } = parseQuery(event, query)
  await assertCanSee(event, workOrderNumber)
  const rows = await loadWorkOrderBom(workOrderNumber, { config: qmsSyncConfig(event), devTools: Boolean(useRuntimeConfig(event).devTools) })
  return previewBom(workOrderNumber, rows)
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestQuery = z.input<typeof query>
