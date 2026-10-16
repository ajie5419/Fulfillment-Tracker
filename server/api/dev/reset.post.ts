import { resetDemo } from '../../services/dev/demo'

/** 清除 DEMO 前缀的数据及引用它们的记录。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return resetDemo()
})
