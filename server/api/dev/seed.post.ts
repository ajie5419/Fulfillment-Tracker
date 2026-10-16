import { seedDemo } from '../../services/dev/demo'

/** 写入演示数据（幂等）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return seedDemo()
})
