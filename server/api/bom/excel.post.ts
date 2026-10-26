import { z } from 'zod'
import { previewTechBom } from '../../services/bom/excel'

/** 整个请求体上限：5MB 文件 + 表单开销。超过直接 413，不读进内存 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
/** .xlsx 是 zip：文件头 PK\x03\x04 */
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

const fields = z.object({ workOrderNumber: z.string().min(1).max(64) }).strict()

/**
 * 预览图纸发放单要附的技术部 BOM（CAD 导出的 Excel；multipart/form-data：file、workOrderNumber）。
 * 只读文件、对照已有工件返回归类结果，不写库；真正建工件在发放图纸时（POST /api/releases 带 bomFileId）。
 * 能发图纸发放单的人（技术部、管理员）。
 */
export default defineFlowHandler(async (event) => {
  const raw = getRequestHeader(event, 'content-length')
  const length = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(length)) throw createError({ statusCode: 411, statusMessage: 'Length Required', message: '缺少 Content-Length' })
  if (length > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '文件太大：不能超过 5MB' })
  const parts = (await readMultipartFormData(event).catch(() => undefined)) ?? []
  const files = parts.filter((p) => p.name === 'file' && p.filename !== undefined)
  if (files.length !== 1) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '请选择一个 Excel 文件' })
  const file = files[0]!
  // Content-Length 只管整个请求；文件本身再查一次
  if (file.data.length > MAX_FILE_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '文件太大：不能超过 5MB' })
  if (!isZip(file.data)) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'BOM 只能是 .xlsx 文件（.xls 请先用 Excel 另存为 .xlsx）' })
  const form: Record<string, string> = {}
  for (const p of parts) if (p.name && p.name !== 'file' && p.filename === undefined) form[p.name] = p.data.toString('utf8')
  const parsed = fields.safeParse(form)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: parsed.error.issues[0]?.message ?? '参数不对' })
  const { workOrderNumber } = parsed.data
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'release', { workOrderNumber, releaseType: 'DRAWING' })
  return previewTechBom(workOrderNumber, file.data)
})
