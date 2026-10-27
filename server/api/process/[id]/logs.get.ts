import { listLogs } from '../../../services/process/process'

/** 一个部件的料单、工艺变更记录：能看到该工单的人 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeProcess(event, id)
  return listLogs(id)
})
