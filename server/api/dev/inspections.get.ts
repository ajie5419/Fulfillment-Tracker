import { listDemoInspections } from '../../services/dev/demo'

/** 演示报检列表（模拟检验结论用）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return listDemoInspections()
})
