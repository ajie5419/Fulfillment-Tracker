import { createRelease } from '../../services/releases/releases'
import { newReleaseBody } from '../../schemas/releases'
import { XLSX_MIME, readBomWorkbook } from '../../services/bom/excel'
import { readOwnUnbound } from '../../services/issues/uploads'

/**
 * 新建发放单：技术部、管理员；工艺部只能发工艺文件（能看到该工单；不审批）。
 * 图纸发放单可带 bomFileId（发放人自己刚上传的 BOM 表）：发出时按图号建工件并关联到发放单。
 */
export default defineFlowHandler(async (event, user) => {
  const { bomFileId, ...input } = await parseBody(event, newReleaseBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber: input.workOrderNumber, releaseType: input.type })
  let bom = null
  if (bomFileId) {
    if (input.type !== 'DRAWING') throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '只有图纸发放单可以附 BOM 表' })
    const buf = await readOwnUnbound(useRuntimeConfig(event).uploadDir, bomFileId, user.qmsUserId, XLSX_MIME)
    if (!buf) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'BOM 表无效或已被使用，请重新选择' })
    bom = { fileId: bomFileId, rows: await readBomWorkbook(buf) }
  }
  return createRelease({ ...input, bom }, user.qmsUserId)
})
