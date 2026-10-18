import { signReceipt } from '../../../services/releases/releases'

/** 签收：只能签发给自己的（服务层校验，别人的 403） */
export default defineFlowHandler(async (event, user) => signReceipt(routeId(event), user.qmsUserId))
