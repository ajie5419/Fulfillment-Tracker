import { lastSupplierOf } from '../services/flow/transit'

/** 发出登记默认的外协厂：当前用户上一次发出用的 */
export default defineFlowHandler(async (_event, user) => {
  return { supplierId: await lastSupplierOf(user.qmsUserId) }
})
