import { z } from 'zod'
import { MAX_BOM_TEXT, bomTextToXlsx, previewTechBom } from '../../services/bom/excel'
import { saveUpload } from '../../services/issues/uploads'

const body = z
  .object({
    workOrderNumber: z.string().min(1).max(64),
    text: z.string().min(1, '请粘贴明细').max(MAX_BOM_TEXT, '明细太长'),
    /** true：转成 .xlsx 存为发放人自己的 BOM 表，返回 upload_file.id（建发放单时带 bomFileId）；false：只预览 */
    save: z.boolean().default(false),
  })
  .strict()

/**
 * 没有 Excel 时，把从 Word / Excel / PDF 复制的图纸明细粘进来（10-24 zhao：技术部暂时只有纸质明细表）。
 * 转成 .xlsx 后和上传的 Excel 走同一套读表、归类；save=true 时把这份 xlsx 存下来，发放时当 BOM 表用。
 * 返回的行号已换成"粘贴内容里的第几行"。能发图纸发放单的人（技术部、管理员）。
 */
export default defineFlowHandler(async (event, user) => {
  const { workOrderNumber, text, save } = await parseBody(event, body)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber, releaseType: 'DRAWING' })
  const { buf, rowOffset } = await bomTextToXlsx(text)
  const preview = await previewTechBom(workOrderNumber, buf, rowOffset)
  if (!save) return preview
  if (preview.errors.length || preview.blocking || preview.workOrderMismatch) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '明细里有问题，改好后再发放' })
  }
  const row = await saveUpload(useRuntimeConfig(event).uploadDir, buf, user.qmsUserId, 'bom')
  return { ...preview, fileId: row.id }
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestBody = z.input<typeof body>
