import { recipientPreviewBody } from '../../schemas/releases'
import { resolveRecipients } from '../../services/releases/recipients'

/** Preview uses the same authorization and recipient expansion as issuing a release. */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, recipientPreviewBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber: input.workOrderNumber, releaseType: input.type })
  const ids = await resolveRecipients(input.userIds, input.groups, user.qmsUserId)
  return { count: ids.length }
})
