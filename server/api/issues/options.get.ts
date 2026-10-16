import { issueOptions } from '../../services/issues/issues'

/** 上报、改派用的下拉：分类（带默认责任部门）、部门 */
export default defineFlowHandler(async () => issueOptions())
