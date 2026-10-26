import { OPERATION_DENIED, canOperate } from '../../services/auth/permissions'
import { FlowForbidden } from '../../services/flow/errors'
import { importPurchases } from '../../services/purchases/import'

/** 整个请求体上限：2MB 文件 + 表单开销。超过直接 413，不读进内存 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
/** .xlsx 是 zip：文件头 PK\x03\x04 */
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/**
 * Excel 导入采购行（multipart/form-data，字段名 file，一个 .xlsx）。
 * 逐行校验；有任何一行不对整批不导入，返回 { imported: 0, errors: [{ row, messages }] }。
 * 只能导入自己看得到、且有权修改采购行的工单（采购部、该工单项目经理、管理员）。
 */
export default defineFlowHandler(async (event, user) => {
  const ctx = await getRoleContext(event)
  // 既不是采购部/管理员、也不是任何工单的项目经理：整个导入都不允许
  if (!canOperate(ctx, 'purchase') && !ctx.pmOf.size) throw new FlowForbidden(OPERATION_DENIED.purchase)
  const raw = getRequestHeader(event, 'content-length')
  const length = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(length)) throw createError({ statusCode: 411, statusMessage: 'Length Required', message: '缺少 Content-Length' })
  if (length > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '文件太大：不能超过 2MB' })
  const parts = (await readMultipartFormData(event).catch(() => undefined)) ?? []
  const files = parts.filter((p) => p.name === 'file' && p.filename !== undefined)
  if (files.length !== 1) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '请选择一个 Excel 文件' })
  const file = files[0]!
  // Content-Length 只管整个请求；文件本身再查一次
  if (file.data.length > MAX_FILE_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '文件太大：不能超过 2MB' })
  if (!isZip(file.data)) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '只能导入 .xlsx 文件（请用页面上下载的模板）' })
  const scope = await getScope(event)
  return importPurchases(file.data, user.qmsUserId, (wo) => canSee(scope, wo), new Date(), (wo) => canOperate(ctx, 'purchase', { workOrderNumber: wo }))
})
